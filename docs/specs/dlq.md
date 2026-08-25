# Spec — Dead Letter Queue (DLQ)

Route `/dlq` · `DLQController` (`/api/dlq`) · `DLQMessagingService` · Lua `read_claim_or_dlq`.

## Goal
Demonstrate at-least-once delivery with bounded retries: messages that fail processing
`maxDeliveries` times are moved to a DLQ stream instead of looping forever. The move is a
**sweep performed by the next poll** (see Flow), not an immediate reaction to the last failure.

## Redis
- Stream `test-stream`, DLQ `test-stream:dlq`, group `test-group`/`mygroup`, consumer `consumer-1`/`worker`.
- Runtime config in `DLQConfigService` (in-memory): `maxDeliveries` (default 2), `minIdleMs` (default 100), `count` (default 100).

## REST (selected)
- `POST /produce` — `XADD` a message.
- `POST /process` — body `{"outcome": "ACK"|"NO_ACK"|"NACK_FAIL"|"NACK_FATAL"|"NACK_SILENT"}`
  (legacy `{"shouldSucceed": bool}` maps to ACK/NO_ACK; invalid outcome → 400). Reads the next
  message via `FCALL read_claim_or_dlq`, then applies the outcome. NACK_* broadcasts
  `MESSAGE_NACKED`.
- `POST /claim` — raw `FCALL read_claim_or_dlq stream dlq group consumer minIdle count maxDeliver`.
- `POST /ack` — `XACK`; broadcasts `MESSAGE_DELETED`.
- `GET /stream/{name}` — `XREVRANGE` (display). `GET /stats` — `XLEN`/`XINFO`/`XPENDING`.
- `GET /pending-messages` — PEL entries with `deliveryCount`, `consumer` (empty = released),
  `idleMs` (-1 = released).
- `POST /init` — create consumer group (`MKSTREAM`).

## Explicit failure — XNACK (Redis 8.8+, ADR-0011)

| Outcome | XNACK mode | Counter | Re-claimable | Story |
|---|---|---|---|---|
| `NO_ACK` | — (no XNACK) | consumed | after `minIdleMs` | crash / silent failure |
| `NACK_FAIL` | `FAIL` | consumed (kept) | **immediately** | "I tried and failed" |
| `NACK_FATAL` | `FATAL` | → `Long.MAX` | swept to DLQ **next poll, no wait** | poison message |
| `NACK_SILENT` | `SILENT` | **refunded** (→ 0) | immediately | "I didn't try" (shutdown) |

Released entries: in PEL, unowned (`consumer` empty, `idle = -1`). UI renders a `released` badge
and `∞ poison` when `deliveryCount >= Number.MAX_SAFE_INTEGER` (JSON rounds `Long.MAX` — threshold
compare only). Backend calls XNACK via raw `Jedis.sendCommand` (no typed API in stable Jedis).

## Flow
`XPENDING` finds messages whose delivery count ≥ `maxDeliveries` → `XCLAIM`+`XADD` to DLQ +`XACK` →
then `XREADGROUP ... CLAIM minIdle` reads claimable + new. Returns `[toProcess[], dlqIds[]]`.
The DLQ check runs **before** the re-read, so it only sees counts from previous calls: a poison
message is delivered `maxDeliveries` times, then swept by the **next** `FCALL` — `maxDeliveries`+1
calls in total, each ≥ `minIdleMs` apart. `XREADGROUP ... CLAIM` **does** increment the delivery
counter (verified empirically on Redis 8.4, 2026-07-09; re-proven on 8.8 by
`DLQXnackIntegrationTest`). Exception: **XNACK-released** messages bypass the `minIdleMs` wait
entirely (see below).

## Narration panel (added 2026-08-25)
`DlqNarrationComponent` — a full-width band between the stream row and the diagrams, hidden until the
first click. `DlqActionsComponent` publishes each click into `DlqScenarioService` (a signal, not a
`Subject`: a panel that mounts late still needs the *current* position, which an event stream cannot
answer); the panel narrates the matching scenario with its intent, the command-level truth, the
ordered steps with the current one highlighted, and the end state to look for.

Step counts come from `GET /api/dlq/config?streamName=test-stream`, so they track the retry budget the
config panel actually saved rather than duplicating its default (fallback `2` when the call fails).

Click counts to reach the DLQ, **measured on the running stack 2026-08-25** with `maxDeliveries=2`:

| Outcome | Clicks to the DLQ | Note |
|---------|-------------------|------|
| `ACK` | never | one click; the entry stays in the stream, dimmed |
| `NO_ACK` | 2 + 1 | the sweeping click answers `success:false` |
| `NACK_FAIL` | 2 + 1 | same budget as a crash, no `minIdle` wait |
| `NACK_FATAL` | 1 + 1 | two clicks total |
| `NACK_SILENT` | never *if it is the only action* | refunds its own delivery; see below |

The `+1` is the `maxDeliveries`+1 call the Flow section describes. That last click reports
**"No messages available to process"** and paints a *red* banner even though it is the click that
routed the message to the DLQ — the panel says so explicitly, because the banner otherwise reads as a
failure at exactly the moment the pattern succeeds.

## XNACK SILENT refunds one delivery, not the history (measured 2026-08-25)

`XPENDING` traces, `maxDeliveries=2`:

| Sequence | Counter after | DLQ |
|----------|---------------|-----|
| `SILENT` ×5 | `0` every time, consumer empty, idle `-1` | never |
| `NO_ACK` then `SILENT` | **`1`**, not 0 | — |
| `NO_ACK`/`SILENT` alternating | reaches 2 on the second pair | **swept** |

So the graceful-shutdown guarantee holds only for a *pure* release loop. Two consequences, both fixed:

- `DLQMessagingService` hardcoded `counterAfter = 0` for `NACK_SILENT`, reporting an empty budget while
  Redis held 1. It now reads the real value with `XPENDING` (`pelDeliveryCount`) — this page exists to
  show what Redis does, so the number it prints comes from Redis.
- `failedVia` must list only actions that **charge** the budget, so it mirrors the counter. Clearing the
  history on `SILENT` made a swept entry report one failure for two clicks.

## Entry & row annotations (added 2026-08-25)

**On the DLQ entry itself.** `read_claim_or_dlq` now writes two fields beyond the copied payload, so a
dead-lettered entry explains itself without any UI state:

| Field | Value |
|-------|-------|
| `reason` | `max deliveries (N) reached`, or `poison (XNACK FATAL): delivery counter forced to max` when the counter was forced past 2^53 |
| `originalId` | the id the entry had in the source stream |
| `failedVia` | ordered, comma-separated actions that charged the budget (`NO_ACK,NACK_FAIL`) — present only when the caller passes the optional `ARGV[6]` |

`failedVia` travels to the sweep as an **optional 6th ARGV**, never as a new KEY: five other services
(`FanOut`, `WorkQueue`, `ContentBasedRouting`, `RequestReply`, plus the loader) and the blog post's six
language samples all call `read_claim_or_dlq` with exactly 2 keys and 5 args, and must keep working
untouched. Absent or malformed, the sweep behaves exactly as before (the decode is `pcall`ed).

Same names as `LlmRecoverySweeper#routeToDlq`, so both DLQs read alike. Verified on the running stack:
a timeout sweep produced `max deliveries (2) reached`, a FATAL nack `poison (XNACK FATAL): …`.

**Trap, measured — do not rediscover.** The viewer must gate that line on **`originalId`**, never on
`reason` alone. `DlqActionsComponent.createRandomMessages` emits `order.cancelled` payloads carrying a
*business* `reason` (`customer_request`, `fraud_detected`, `payment_failed`, `out_of_stock`), so keying
off the field name labels a healthy entry in the main stream as if it had been dead-lettered — seen in
a browser before the guard existed. Guarded by
`stream-viewer.component.spec.ts` ("does not mistake a business \"reason\" field…"), proven by
re-introducing the fault.

**Where it is shown.** A short badge in the message **header** — `⚠ Timeout ×2`, `⚠ Poison`,
`⚠ Timeout → Explicit fail` — with the mechanism and the original id on hover
(`max deliveries (2) reached — originally 1787…-0`). Deliberately terse: we are already looking at a
DLQ, so "fail" is a given.

The badge **summarises, it does not replace**: every field stays in the body, sweep bookkeeping
included, because this viewer shows what the stream holds. The card is sized for it instead —
`[messageHeight]="205"` on the DLQ viewer, against the source column's 125 default. Measured after the
change: six rows rendered, `scrollHeight - clientHeight = 0`.

**Column height 861, measured rather than estimated.** A card's pitch is **127px** (125 + a 2px gap),
the container adds 16px of vertical padding, and the viewer's header plus footer cost **85px**:
`6 × 127 − 2 + 16 + 85 = 861`. At that height `clientHeight == scrollHeight == 776` and all six
generated messages are on screen with no scrolling. Two earlier guesses (755, then 835) each left the
sixth card cut off — the arithmetic only closed once the gap and the padding were measured.

**On the row in the source stream.** `DLQEvent.failureKind` (typed enum, not a `details` string match)
tells the viewer how the last attempt failed: `TIMEOUT` → `⏱ timeout`, `EXPLICIT_FAIL` →
`⚡ explicit fail`. `POISON` and `RELEASED` are carried too but deliberately **not** badged again — the
delivery counter already renders `∞ poison` / `released`, and a second badge adds nothing. An `XACK`
clears the kind, because a stale failure badge on a succeeded message is a lie.

## Action panel behaviour (2026-08-25)

- **Window of 20 entries per column, and no pagination** (there never was any: the
  `.more-messages` line has never had a click handler). The window matters because of an ordering
  mismatch worth knowing: the viewer shows the **newest** `pageSize` entries (`XREVRANGE ... COUNT`)
  while a consumer group delivers the **oldest undelivered** first. Once the stream exceeds the window,
  the next message to be processed is off-screen *by construction*, so a click on Process changes
  nothing visible — which reads exactly like a broken button.
  **Measured 2026-08-25, with 12 messages and a window of 10:** `/messages?count=10` returned n =
  12…3, and 12 consecutive ACKs consumed all 12 distinct ids (then "no messages available", PEL 0).
  Nothing was ever unreachable; the first two clicks simply acted on the two oldest, which were not
  rendered. At a window of 20, two clicks on Generate leave `12 of 12 messages` on screen and all 12
  end up visibly marked.
  Past 20 the line stays, now honest: it counts `totalMessages - displayedMessages.length` (subtracting
  `pageSize` understated it as soon as a trim removed a row) and it says *why* it matters — those
  entries are processed first.
- **Generate Messages produces six entries**, not four: with `maxDeliveries` at 2 a single scenario
  burns three clicks, so four messages ran out mid-demonstration.
- **Status line lasts 10 s** (`STATUS_VISIBLE_MS`), or until the next one replaces it. One shared timer,
  not one per call: with per-call timers an earlier 10 s timeout wiped a status posted 2 s later.
- **A failing outcome is red.** `NO_ACK` / `NACK_FAIL` / `NACK_FATAL` return `success: true` — the call
  worked, the message did not — so colouring by the HTTP flag alone printed "processing failed" in a
  green box. `NACK_SILENT` stays green: a graceful release refunds the budget, nothing failed.
- **Clear All asks through `ConfirmDialogComponent`**, not `window.confirm`. In-house rather than
  `MatDialog`: `@angular/material` is a dependency but used nowhere, so the first use would drag a
  global theme into an entirely hand-styled app. Cancel is focused on open, Escape cancels, and the
  backdrop is deliberately not click-to-dismiss.

## Edge cases / acceptance
- A message ACK'd stays in the stream, dimmed with an `acked` badge (`MESSAGE_ACKED`, not
  `MESSAGE_DELETED` — there is no `XDEL` in this codebase; corrected 2026-08-25).
- After `maxDeliveries` failed deliveries, the **next** poll moves the message to `test-stream:dlq`
  and clears it from the main stream's PENDING list.
- Re-claim only after `minIdleMs` has elapsed.
- The narration panel is hidden before the first click and after **Clear All Streams**.
- **Any attempted message stays dimmed** (`handled`, opacity `0.38`), success *or* failure: what a
  viewer needs is how far down the stream the demo has got, and a failed attempt is still an attempt. A
  success additionally carries the `acked` badge — `MESSAGE_PROCESSED` has exactly one emitter (this
  page's ACK path) and the entry is XACKed straight after, so treating it as acknowledged is accurate
  rather than optimistic.
- An acknowledged entry **never** shows a delivery-count badge. The success event is broadcast *before*
  the XACK lands, so a pending poll in flight can still read the old row — which put a `2×` badge next
  to `acked` on the same card. `refreshPendingInfo` now leaves acked entries alone.
- A DLQ entry always carries `reason` + `originalId`; a main-stream entry never does.

## Naming (resolved 2026-07-09)
The effective defaults are `DLQConfigService.DEFAULT_CONFIG`: stream `test-stream`, DLQ
`test-stream:dlq`, group `test-group`, consumer `consumer-1`, `minIdleMs=100`, `count=100`,
`maxDeliveries=2`. The `mystream`/`mygroup`/`worker` values in `DLQProperties`/`DLQParameters`
are **dead builder defaults** — the UI path always goes through `DLQConfigService`.
