# Spec — Per-Key Serialized Processing

Route `/per-key-serialized` · `PerKeySerializedController` (`/api/per-key-serialized`) ·
`PerKeySerializedService`.

## Goal
Process jobs in **parallel across keys** but **strictly serial per key** (e.g. never two jobs for
the same `orderId` at once), without a global lock.

## Redis
- Stream `jobs.perkey.v1` (fields `orderId`, `action`), single group `jobs-serialized-group`.
- Per-key lock `running:order:{orderId}` = messageId, `SET NX PX 30000`.
- Per-worker done streams `jobs.perkey.v1.worker{1..3}.done`.

## REST
- `POST /per-key-serialized/submit` — `XADD` a batch of jobs.
- `DELETE /per-key-serialized/clear`.

## Flow
3 Virtual Thread workers share one group. Per job: try `SET running:order:{orderId} NX PX 30000`
(value = the messageId, used as an ownership token).
- Lock acquired → process (~4s) → copy to worker's done stream → `XACK` → release the lock via
  `FCALL release_lock` (compare-and-delete: deletes only if the lock still holds **our** token, so a
  worker can never delete a lock another worker re-acquired after a TTL expiry).
- Lock held by another → **skip** (don't block); leave message pending. `XAUTOCLAIM` (idle 10s,
  above the ~2.7s processing time) re-delivers it later, by which time the holder has released the lock.

## Time-slot lanes

### Why
The guarantee *is* the pattern, and the page never showed it. A viewer sees jobs land in three done
streams and has to take the serialization on trust. The lanes make it visible: **one row per time
slot, one column per worker, one background colour per key**. Two cells of the same colour in one row
means two workers held the same key at once — the one thing the lock exists to prevent.

`PerKeySerializedIntegrationTest#twoJobsOnTheSameKeyNeverOverlap` already asserts this, but *indirectly*:
it infers non-overlap from the gap between completions, because the done stream only carries
`processedAt` (an end). The lanes need starts, so the service has to say when work begins.

### Event contract
New DTO `PerKeySlotEvent`, broadcast on the existing socket via a new
`WebSocketEventService.broadcastEvent(PerKeySlotEvent)` overload — the same shape as `PubSubEvent` and
`LlmChatEvent`. **Deliberately not a new `DLQEvent.EventType`:** `DLQEvent` is consumed by
`stream-viewer` on all 12 pages, and this payload has nothing in common with it.

| Field | Type | Notes |
|-------|------|-------|
| `eventType` | `String` | always `PER_KEY_SLOT` — every event on this socket carries an `eventType`, and components filter on it before looking at anything else (`pubsub-subscriber` does exactly this). Found while planning; without it a component cannot tell this event from a `DLQEvent`. |
| `phase` | `STARTED` \| `FINISHED` \| `LOCK_SKIPPED` | |
| `workerId` | `int` | 1..3 (`NUM_WORKERS`) — the column |
| `orderId` | `String` | the key — the colour |
| `action` | `String` | shown in the cell / on hover |
| `messageId` | `String` | correlates `STARTED` with `FINISHED` |
| `atMs` | `long` | **epoch millis, not `LocalDateTime`** |

`atMs` is numeric because the frontend does *arithmetic* on it (slot binning, interval overlap). The
other DTOs keep `@JsonFormat` because they only ever display their timestamp.

Emission points, all in `PerKeySerializedService.processEntry`:

| Condition | Phase |
|-----------|-------|
| `lockResult == null` (today only a `log.info`) | `LOCK_SKIPPED` |
| lock acquired, **before** `Thread.sleep(PROCESSING_SLEEP_MS)` | `STARTED` |
| after the `XADD` to the worker's done stream | `FINISHED` |

`STARTED` must precede the sleep, otherwise a 4s job only appears once it is over.

### Frontend model
`PerKeyLanesComponent` folds the event stream into:

- `Run { messageId, workerId, key, action, startMs, endMs | null }` — keyed by `messageId`
- `Skip { workerId, key, atMs }`

Slots are **1000 ms**, anchored on the first event seen (`slot(t) = floor((t - anchorMs) / 1000)`).
Rows run from `max(0, currentSlot - 119)` to `currentSlot` (see the cap below) — not from slot 0;
columns are the three workers; a cell is filled when a run
covers that slot on that worker, tinted by key. **Each cell names its action** next to the key
(`#1001 recalculateTotal`): the colour says *which* key is held, and without the action a row saying
"#1001" four times tells a viewer nothing about the work being serialized. A `LOCK_SKIPPED` draws a hatched marker in the cell
of the worker that was refused — that refusal is the mechanism, so it is worth the visual noise.

### Violation rule
A violation is **overlap of the `[startMs, endMs)` intervals of two runs sharing a key**, *not* two
cells colliding in a slot. Slot collision alone would cry wolf: a job ending at t=4.0s and the next
on the same key starting at t=4.1s share slot 4 without ever overlapping, and that sequence is the
*correct* behaviour of the lock. The grid is for reading; the interval is for judging. A row
containing any cell of an overlapping pair is outlined, and a counter states the number of **distinct
overlapping pairs of runs** seen since the page loaded (not the number of outlined rows — one overlap
spanning four slots outlines four rows but counts once).

### Clock, timers and bounds
- **Never compare `atMs` with a raw `Date.now()`.** `atMs` is the backend's clock (a container), the
  browser's is the host's; they drift. Keep `offsetMs = firstEventAtMs - Date.now()` on the first
  event and derive "backend now" as `Date.now() + offsetMs`.
- The component owns a **1 s tick** so an in-progress run grows while it runs. That makes it one of
  the components for which `fixture.whenStable()` never resolves (documented trap) — specs use
  `settle()`, never fake timers.
- **The tick only runs while a job is in flight** (added 2026-08-26): a run with no `FINISHED` whose
  lock has not expired. Once the last job lands the clock freezes at that event, so a page left open
  after the demo drains stops growing a row per second. The TTL bound matters as much as the
  `FINISHED` — a worker killed mid-job never reports finishing, and that one run would otherwise keep
  the clock alive for the whole session. The state is rendered (`data-clock`, `▶ live` / `⏸ stopped`)
  so it is assertable and visible. **Measured:** drained at 46 rows, then +30 s idle → **grew by 0**.
  Consequence accepted: the clock also pauses in the gaps *between* same-key jobs, while the backlog
  waits for `RECLAIM_MIN_IDLE_MS`. Nothing is lost — the next event carries its own `atMs`, so those
  idle seconds are drawn when it arrives, retroactively rather than live. Ticking through those gaps
  would need a backlog signal (`XINFO GROUPS` lag + pending) that no event currently carries.
- **Assert the clock *rule*, never "rows grew after a wait".** The tick's phase is fixed at component
  init, not at the first event, so waiting one slot can advance the clock by **less than** one slot
  (measured: 948 ms after a 1300 ms wait) and the assertion is racy by construction. Freezing is the
  exact half: nothing may advance, ever.
- Runs and skips are capped at the most recent **120 slots**; older entries are dropped. A demo page
  left open for an hour must not grow without bound.
- **Live only.** The grid starts empty on reload, like the streams it watches (they are cleared on
  backend startup, and Redis is wiped per ADR-0012). No new stream, no reconstruction from
  `processedAt`.

### Edge cases
- **`FINISHED` never arrives** (worker killed, page opened mid-run): the run stays open. Since the
  lock's TTL is `LOCK_TTL_MS` (30 s), an open run older than that is rendered as ending at its start
  slot + 30 s and marked "end unknown" rather than growing for ever.
- **`FINISHED` before `STARTED`** (page opened mid-run, or reordering): create the run from the
  `FINISHED` with `startMs = null` and render only its end slot. Never drop the event.
- **Same key, same worker, sequentially**: not a violation. Only overlap is.
- **A key with no colour** (more distinct keys than the palette): fall back to the existing
  `getOrderColor` default (`#64748b`) and keep the key label, so two uncoloured keys are still
  distinguishable by text.
- `getOrderColor` moves out of `PerKeySerializedComponent` into a shared helper: the job list and the
  grid must tint `#1001` identically, or cross-reading the two is actively misleading.

### Acceptance (lanes)
- Submitting the default batch (5 jobs on `#1001`, then one each on `#2002`..`#6006`) renders a grid
  where **no row ever holds two cells of the same colour**, and the five `#1001` jobs occupy
  consecutive, non-overlapping slot ranges.
- Different keys visibly share slots — that is the parallelism half of the claim.
- At least one hatched `LOCK_SKIPPED` marker appears while `#1001` is held (the other workers do try).
- Injecting two overlapping runs on one key outlines the row and increments the counter.
- Slot binning and overlap detection are **pure functions**, unit-tested without timers.

**Measured 2026-08-25** against the Docker stack (backend rebuilt, default batch submitted, grid
watched for 40 s):

| Criterion | Result |
|-----------|--------|
| No row holds two cells of the same colour | 0 rows, over 40 slots |
| The `#1001` jobs occupy consecutive, non-overlapping ranges | t+0…4, t+10…14, t+20…24, t+31…35 |
| Different keys share rows | 10 of 40 rows have >1 worker busy |
| `LOCK_SKIPPED` markers appear while `#1001` is held | 11 markers |
| Overlap counter | `0 overlaps` |
| Browser console | clean |

Those slot ranges are five rows long because the walkthrough ran against `PROCESSING_SLEEP_MS = 4000`.
**Cut to 2700 ms on 2026-08-26** (four rows per job read as sluggish): bars are now **3–4 rows,
mean 3.6** over 11 jobs.

Cutting the work time alone moved the demo's wall clock almost not at all — 46 rows to 45 — because
the pace was set by the **gaps**, not the bars. `RECLAIM_MIN_IDLE_MS` was 10 s, and a job whose key was
busy had its idle timer reset by the very claim that refused it, so the next attempt came a whole
reclaim window later. Measured **10324 ms** between consecutive same-key completions, with all three
workers idle through most of it.

**`RECLAIM_MIN_IDLE_MS` is now 1000 ms — deliberately shorter than the work time**, inverting the rule
the other claim-based patterns must follow. It is safe here and *only* here because **minIdle is not
what prevents a second run in this pattern; the `SET NX` lock is.** An early claim on a held key fails
the lock and is dropped, costing one refused round trip. Result: same-key latency ~4.2 s
(work + minIdle + poll), the default batch **46 rows → 16**, and the grid's `⊘` markers multiply —
that is the deferral mechanism becoming visible, not noise.

**How that safety claim was proved, and how the obvious test failed to prove it.**
`oneSaturatedKeyIsNeverProcessedTwiceEvenThoughMinIdleIsBelowTheWorkTime` (6 jobs, 3 workers) passes
**even with `.nx()` removed from the lock** — saturation keeps every worker busy in lockstep, so no idle
worker is ever available to steal an in-flight entry, and the risk is never exercised.
`anInFlightJobIsNotReRunByAnIdleWorkerWhoseClaimBeatsTheWorkTime` submits **one** job precisely so two
workers sit idle while it runs; with the lock neutered it fails with **three completions for one
submitted job**. Keep both, but know which one is the guard.

**The detector was proven able to fail, and the plan's recipe for doing it was wrong.** Lowering
`RECLAIM_MIN_IDLE_MS` below the processing time does *not* breach this pattern: the early claimant
still meets a live lock and is refused, which is the pattern working. `LOCK_TTL_MS` must drop below
the processing time as well, so the holder's lock expires mid-work and a peer legitimately acquires
it. With both at 1000 ms against 4000 ms of work, the grid showed **`1 overlap` and four
red-outlined rows** (`#1001` on worker-1 and worker-2 through t+5…t+8). Both constants are back at
30000 / 10000, and a re-run of the walkthrough returned to `0 overlaps`.

That run also **measured the cost of the naive rule this spec rejects**. A slot-collision detector,
computed independently from the same DOM, flagged **5** rows; two of them (t+4, t+17) were hand-offs
where one run ended and the next began inside the same second without ever overlapping. Interval
judgement outlined 4 rows, all of them the one real breach — so slot collision would have been
**40% false positives on the very run that contained a genuine violation**.

The refusal marker is `⊘` (U+2298), not `⃠` (U+20E0): the latter is a *combining* enclosing mark and
merged into the key label of the cell it was drawn in.

## Acceptance
- Two jobs with the same `orderId` never run concurrently; they serialize.
- Jobs with different `orderId`s run in parallel across the 3 workers.
- A lock is only ever released by its owner (compare-and-delete), never by a different worker.
