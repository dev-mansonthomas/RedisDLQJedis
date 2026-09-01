# TODO / Review Findings

> Consolidated from build/lint/test runs, `/code-review` (working diff), and a manual security
> review (the `/security-review` skill couldn't run — no `origin/HEAD` in this VM).
> Date: 2026-06-26. Severity: 🔴 high · 🟠 medium · 🟡 low.

## Security

- 🟡 **`.env` is committed and not gitignored** — *accepted (2026-06-26)*: this is a demo that
  requires no credentials to run; `.env` holds only `REDIS_HOST`/`REDIS_PORT`. **Revisit if any
  secret (e.g. `REDIS_PASSWORD`) is ever added** — at that point gitignore `.env*`,
  `git rm --cached .env`, and ship a `.env.example`.
- 🟠 **No authentication/authorization** on any REST or WebSocket endpoint (ADR-0008). Acceptable
  for a localhost demo; a blocker before any network exposure.
- ✅ **CORS and WebSocket origins locked to an explicit allow-list** (`CorsConfig`, `WebSocketConfig`,
  `app.cors.allowed-origins`, default local frontend/backend) — *done 2026-06-29, PR #3*. Previously `*`.
- ✅ **Mermaid diagram rendering sanitized** — `securityLevel: 'antiscript'` (DOMPurify on the SVG
  before the `innerHTML` sink) — *done 2026-06-29, PR #3*.
- 🟠 **Redis runs with no password by default** (`REDIS_PASSWORD` empty in compose/env). Set a
  password + consider ACLs/TLS for any non-local use (see `redis-security`).
- ✅ **`frontend/Dockerfile`'s blanket `chmod -R a+r` on the nginx web root is replaced** —
  *done 2026-08-28* by `chmod -R u=rwX,go=rX`, which states the intent instead of only widening it:
  `X` adds `+x` to directories only. `a+r` never added the `+x` a directory needs to be traversed,
  and never cleared an execute bit a build artifact should not carry. Measured in the running
  container: `755` on directories, `644` on files, **0** world-executable files, **0** directories
  nginx cannot traverse. (busybox `chmod` does accept the `X` symbolic mode — checked, not assumed.)

## Correctness / build

- ✅ **XNACK is typed; Jedis 8.0.0** — *done 2026-08-21*. `DLQMessagingService.XnackCommand` (and the
  test's copy of it) are gone: `jedis.xnack(stream, group, XNackMode.FAIL, id)`. Signature checked with
  `javap` on the jar first. `ProcessOutcome.xnackMode()` now returns `XNackMode`, not a `String` token.
  Jedis 8's breaking changes do not touch this project (`JedisPooled`/`JedisSentineled` removals and
  RESP3 auto-negotiation apply to UnifiedJedis-based clients; this uses `JedisPool`).
- ✅ **Spring Boot 4.1.1 + Jackson 3** — *done 2026-08-21*, see ADR-0013. Two moves were needed beyond
  the version bump: `@WebMvcTest` lives in `org.springframework.boot.webmvc.test.autoconfigure`
  (artifact `spring-boot-starter-webmvc-test`), and the auto-configured `ObjectMapper` is Jackson 3, so
  14 files moved from `com.fasterxml.jackson.databind` to `tools.jackson.databind`. Verified beyond the
  suite because tests cover only 3 of 12 patterns and **none** covers WebSocket: 23/23 GET endpoints
  return valid JSON, the WS stream delivers parseable events, `@JsonFormat` is still honoured
  (`"timestamp":"2026-08-21T08:41:57.389"`, 3 decimals), and request/reply round-trips through
  `writeValueAsString` + `TypeReference`.
- 🟡 **Post #1's samples pin stale client versions** (found while planning post #2, 2026-08-11):
  `blog/dlq-redis-streams/samples/` uses NRedisStack `0.13.1` (latest **1.7.3**), Rust `redis` `0.32`
  (latest **1.5.0**, i.e. now past 1.0), go-redis `v9.21.0` (latest `v9.22.0`) and Jedis `7.5.3`
  (latest `8.0.0`); the Python/Node pins float and already resolve to the latest. They still run, so
  this is a chore, not a bug. → Bump in one pass **after** post #2 ships, and re-run
  `blog/dlq-redis-streams/verify.sh`; the NRedisStack and Rust jumps cross majors, so expect API edits.
- ✅ **Frontend test runner shipped** — *done 2026-08-21*: `npm test` runs Vitest specs (18 then, **110** today) through
  `@angular/build:unit-test`, with `tsconfig.spec.json` wired so specs are actually type-checked
  (verified by planting a type error and watching the run fail). Covers slice A of
  [`specs/frontend-test-runner.md`](specs/frontend-test-runner.md) — `computeRate`'s 6 cases — plus the
  OnPush guards below. Slice C (browser mode for the 4-column grid rule) is still open.
- ✅ **CI exists** — *done 2026-08-21*, `.github/workflows/ci.yml`. Three jobs (backend / frontend /
  lua) on every PR and every push to `main`. The documented trap is handled head-on: the backend job
  refuses to pass if **any** test was skipped, because the Redis integration tests assume themselves
  away when Docker is missing — a Docker-less runner would otherwise report green while testing almost
  nothing. That gate was verified by planting `skipped="8"` in a surefire report and confirming it
  fails with the offending class named. It also floors the suite at 154 tests (160 today; it read 100 when this line was written). Every step
  was run locally from a clean `npm ci` before being written into the workflow.
  Still manual, deliberately: the browser-mode layout rule (slice C) and the 12-page walkthrough.
### Toolchain inventory (required vs VM, updated 2026-06-29)

| Tool | Required (source) | VM | Status |
|------|-------------------|----|--------|
| JDK | 21 (`pom.xml`, Dockerfile temurin-21) | 21.0.11 | ✅ installed |
| Maven | 3.9 (Dockerfile `maven:3.9`) | 3.9.16 | ✅ installed |
| Node | 24 (frontend Dockerfile `node:24-alpine`) | 24.16.0 | ✅ parity (row was stale until 2026-08-28) |
| luacheck | dev-only Lua lint (`.luarc.json`) | 1.2.0 (Lua 5.1) | ✅ installed |
| redis-cli | client for `lua/load.sh` | 7.0.15 | ✅ ok as client; local *server* must be 8.8+ (use Docker) |
| Docker / Compose | modern (`docker compose`, no v1 `docker-compose`) | 29.5.2 / v5.1.4 | ✅ |
| npm / git | bundled / any | 11.13.0 / 2.43.0 | ✅ |

No multi-version needs (single Java 21, single Node line; no `.nvmrc`/`.tool-versions`/Python/Go/PHP/TF).
Node parity: ✅ *resolved 2026-08-21* — the frontend Dockerfile build stage is `node:24-alpine`,
matching the VM (Angular 22 requires node ^22.22.3 || ^24.15.0 anyway).
- ✅ **`TokenBucketService` `XREADGROUP_UNDELIVERED_ENTRY`** (Jedis 7 API) — compile-verified via the
  Docker build; the service also now uses registered `FCALL acquire_token`/`release_token` instead of
  inline `EVAL`.

## Quality / cleanup (from `/code-review` of the working diff)

- ✅ **Diagram-to-page mapping verified — it was never swapped** — *checked 2026-08-21*. Each page
  does show its intended diagram: the definition named `topicRouting` described Pub/Sub pattern
  subscribers and `keyRouting` described the Lua `route_message` stream router, so only the *names*
  were misleading. Renamed to `pubsubTopicRouting` and `streamTopicRouting` so the trap cannot be
  re-reported. Both pages re-checked in a browser: 2 diagrams each, no mermaid syntax error.
- ✅ **The API base URL is centralized and relative** — *done 2026-08-28*, see
  [ADR-0014](adr/0014-same-origin-api-base-path.md). **19** call sites, not ~14. This was filed as a
  portability chore and it was also a live misconfiguration: `frontend/nginx.conf` *already* proxied
  `/api/` and `/api/ws` to `backend:8080`, and the absolute URLs bypassed that proxy, making every
  REST call and the SockJS handshake cross-origin to a different port. That is the only reason the
  demo needed CORS on its happy path.
  Now one constant, `API_BASE = '/api'` (`frontend/src/app/api.config.ts`), plus a new
  `frontend/proxy.conf.json` wired into `angular.json` (`serve.options.proxyConfig`) — without it
  relative URLs have nowhere to go under `ng serve`. An eslint `no-restricted-syntax` rule (two
  selectors, `Literal` and `TemplateElement`, both proven to fire) stops the 19 coming back.
  Measured in a browser on `/dlq`, `/per-key-serialized`, `/work-queue`, `/llm-chat`: every `/api`
  request goes to host `localhost:4200`, SockJS upgrades to
  `ws://localhost:4200/api/ws/dlq-events/...`, `Burst 200 jobs` POSTs to
  `localhost:4200/api/work-queue/produce/burst` → 200 with 399 jobs flowing, 0 console errors.
  Dev-server proxy proven wired by its failure mode: `/api/dlq/config` with no backend up returns
  **502**, where an unwired proxy returns the SPA `index.html` with 200.
- 🟡 The in-flight mermaid feature repeats the same `diagrams = inject(DiagramDefinitionsService)`
  + identical `<app-mermaid-diagram>` block across ~11 components. Acceptable, but a shared wrapper
  or a small base could reduce duplication.

## Found while implementing the dynamic worker pool (2026-07-31, slice A of blog post #2)

- ✅ **`minIdle` had zero safety margin in the Work Queue — fixed 2026-08-03 by the demo-mode presets.**
  `WorkQueueService` used `MIN_IDLE_MS = 100` with a 100 ms simulated processing time, so a *free* worker
  claimed jobs its busy peer was still processing and they ran **twice, silently** — no error, empty PEL,
  empty DLQ. The 100/100 pair was **not** in fact safe: measured on the running page, **120 of 266**
  completed jobs were duplicated (386 done entries for 266 unique `jobId`s across the 4 done streams).
  Fix: timing is now a `WorkQueueService.DemoMode` preset (`SLOW` 2000/5000 ms, `FAST` 50/500 ms) whose
  constructor enforces `minIdleMs >= 2 * workMs`. Guards: `WorkQueueDemoModeTest` (no Redis, so it never
  skips) + `WorkQueueScalingIntegrationTest#neitherShippedModeLetsAFreeWorkerStealAnInFlightJob`; the
  failure mode stays characterized by `…#aFreeWorkerStealsAnInFlightJobWhenProcessingExceedsMinIdle`.
  Blog post #2 must still state the rule.
- ✅ **The duplication risk is now audited in Token Bucket and Per-Key Serialized** — *done
  2026-08-21*, both clean. `TokenBucketIntegrationTest#saturatingTheBucketDoesNotProcessAnyJobTwice`
  queues 12 jobs against a cap of 3, which forces waiting messages past the 15s idle threshold and
  back through `XAUTOCLAIM` with 18 workers in one group: no duplicate, nothing left pending, and the
  token counter back to zero. `PerKeySerializedIntegrationTest#noJobIsProcessedTwice` does the same
  for the per-key lock. **Worth knowing:** Token Bucket's margin is 1.5x, not the 2x rule of thumb
  (`RECLAIM_MIN_IDLE_MS` 15000 vs a 10000ms CSV job). It is safe because minIdle still exceeds the
  work time, but those two constants are now coupled — raising a job's processing time above 7.5s
  without raising the reclaim threshold reintroduces the failure mode.
- ✅ **The LLM Chat recovery sweeper is audited** — *done 2026-08-28*, `LlmRecoveryDuplicationTest`
  (4 cases, ~22s). **The planned recipe — saturate it — was the wrong shape, the same lesson Per-Key
  Serialized recorded.** Every other pattern is protected by *timing* (`minIdle` outlasting the work)
  or by a *Redis* lock; here `minIdleMs` (3250 ms) is deliberately **shorter** than a slow generation,
  so the sweeper *does* reclaim live entries, repeatedly. The only thing between that and a doubled
  reply is `LlmResponderWorker.isInFlight` — an in-process `Set` (ADR-0010). So the audit drives that
  guard head-on: one message, a ~2.4s generation against a 300 ms `minIdle`, ~20 reclaims of a live
  entry, and exactly one reply must land. Replies echo the prompt, so a duplicate is detected by
  content, not by count alone.
  **Proven able to fail:** with `isInFlight` stubbed to `false`, **3 of the 4 cases go red** — 2
  identical replies for one message, and **13 replies for 8 messages**. The 4th
  (`everyUserTurnRemainsInTheStreamExactlyOnce`) stays green under that regression and says so in its
  javadoc: it pins the premise of the content-based detection, it is not an audit case.
  A third case pins an ordering that is easy to break: the in-flight check sits **before** the
  delivery-count check, so a generation reclaimed more often than `maxDeliveries` is not
  dead-lettered for being slow.
  **Limit, unchanged and by design:** the guard is in-process, so a second backend instance sweeping
  the same conversation would not see the first one's in-flight set (ADR-0010 already states this).
- ✅ **`@CrossOrigin(origins = "*")` is gone from every controller** — *done 2026-08-28*. It was on
  **12** of the 13, not just `WorkQueueController` (only `LlmChatController`, the newest, was clean).
  **The severity was overstated when this was triaged, and measuring corrected it:** the annotation
  did *not* defeat the allow-list. `CorsConfig` installs a `CorsFilter`, which runs before the
  `DispatcherServlet` and rejects a foreign origin with **403** whatever the handler declares — the
  annotation-beats-global-config rule applies to a `CorsRegistry` (`addCorsMappings`), not to a
  standalone filter. So this was dead code, not an active bypass, and removing it is hygiene: it was
  a trap armed for the day the filter is dropped or reordered.
  Guarded by `CorsAllowListTest` (5 cases): the allow-list echoes an allowed origin, rejects a
  foreign GET and a foreign preflight, a wildcard `@CrossOrigin` controller behind the real filter
  still 403s (the characterization case), and a classpath scan asserts **no** controller carries the
  annotation — with a floor of 12 `@RestController`s found, so the scan cannot pass vacuously.
- ✅ **`fanOut` diagram matches the code** — *done 2026-08-21*. It was wrong in three ways, not one:
  3 named services instead of 4 workers, `events.fanout.v1` instead of `fanout.events.v1`, and
  invented done-stream names. Rewritten against the service: 4 workers, the real stream/DLQ/done
  names, and — the point of the pattern, previously absent — **one consumer group per worker**, with
  the label saying why that makes it a broadcast. `flowchart LR` was tried and reverted: it rendered
  1120×1300 with crossing edges and a stranded producer, where `TB` stays compact.
- ✅ **The stream viewer no longer empties itself** — *done 2026-08-21*. The cause was an event that
  lied: seven services broadcast `MESSAGE_DELETED` after an `XACK`, and there is **no `XDEL` anywhere
  in this codebase** — a stream is a log. The viewer believed them and dropped the row while
  `totalMessages` kept the real count, hence `0 of 199 messages` against an `XLEN` of 200.
  Fix: a new `MESSAGE_ACKED` event type; the seven ack-time emitters use it; the viewer **marks** the
  row (dimmed, `acked` badge) instead of removing it, and leaves the total alone. `MESSAGE_DELETED`
  now has exactly one emitter — `StreamMonitorService`, the only code that can actually know an entry
  disappeared, because it diffs the ids it has seen against the ids the stream still holds.
  Measured after a 40-job burst: `10 of 40 messages` with 10 `acked` badges, 0 console errors.

## Found while making Redis ephemeral (2026-08-20, ADR-0012)

- ✅ **Redis no longer keeps state between demo runs** — *done 2026-08-20*: no volume,
  `--save "" --appendonly no`, and `launch-docker.sh` flushes between `stop backend` and `up -d`
  (order matters — see ADR-0012). Measured on the running stack: `DBSIZE` 227 → 0, backend healthy,
  `jobs-group` recreated with 4 consumers, 0 `ERROR` since restart. `--keep-data` opts out.
- ✅ **`stop-docker.sh` / `clean-docker.sh` were broken in this VM** — *fixed 2026-08-20*: both called
  the v1 binary `docker-compose`, which is not installed (compose v5.1.4 plugin only), so every
  invocation died on "command not found". Now `docker compose`.
- ✅ **Shutdown is silent again** — *done 2026-08-20*. The backend logged `Could not get a resource
  from the pool` ERRORs on every stop: **no service had a `@PreDestroy`**, so Spring closed the
  `JedisPool` while the worker Virtual Threads kept polling. Three services even declared an
  `AtomicBoolean shutdown` that **nothing ever set** (`PerKeySerializedService`,
  `ContentBasedRoutingService`, `TokenBucketService`), and `RequestReplyService` did not even keep a
  reference to its two listener threads. Now: `@PreDestroy` on all 8 worker-owning services (new hooks,
  or the annotation on the existing `stopWorkers()`/`shutdown()`), each generic `catch` breaking out
  instead of logging when the flag is set, and `WebSocketEventService` dropping broadcasts once the
  context closes (which also silenced the `WebSocket transport error` / `Failed to broadcast` pair that
  surfaced underneath). Measured: **3 ERRORs → 0** on `docker compose stop backend`, 93 tests green.
- ✅ **The legacy `redismessagingpatternswithjedis_redis-data` volume is gone** — removed 2026-08-20 on
  request; this line was left stale until 2026-08-21.

## Found while upgrading to Spring Boot 4 (2026-08-21)

- ✅ **`GET /api/dlq/stats` is quiet on an empty state** — *done 2026-08-21*: `getPendingCount` now
  treats `NOGROUP` as "0 pending" at DEBUG and keeps ERROR for everything else. A freshly flushed
  Redis whose DLQ page nobody opened no longer looks broken in the logs.

## Found while upgrading the frontend (2026-08-21)

- ✅ **OnPush is guarded where it can be** — *done 2026-08-21*. `pubsub-subscriber` and `llm-chat` have
  specs that drive a WebSocket event through a stub and assert the **DOM** changed; both were proved by
  injecting the real regression (mutating the signal in place instead of replacing it) and confirming
  they go red. The llm-chat one pins token-by-token growth, i.e. the exact symptom reported on the LLM
  Chat page.
  **Finding worth keeping:** the failure is only observable when no other signal is written in the same
  turn. `dlq-actions` turned out to be unguardable for this reason — turning its `statusMessage` into a
  plain field leaves its specs green, because `isProcessing`/`isError` are written in the same callback
  and mark the view dirty anyway. So the remaining exposure is narrow but real: a *new* component (or a
  new code path) whose repaint hangs on a single signal. → When adding one, add its guard.
- 🟡 **`request-reply` still trusts the WebSocket payload shape.** `handleResponse` is typed
  against a hand-written `ResponsePayload` interface that mirrors the backend by convention only;
  nothing fails if the backend DTO drifts. Same for the new `PubSubEvent` frontend interface.

## Demo legibility — requested by the author 2026-08-21

These are about what a prospect *sees*. They are feature work, not defects, except where noted.

- ✅ **DLQ page now says what is being demonstrated, and what is left to do** — *done 2026-08-25*.
  `DlqNarrationComponent` + `DlqScenarioService`: a full-width band under the stream row, hidden until
  the first click, then narrating the clicked scenario's intent, its command-level truth, its ordered
  steps with the current one highlighted, and the end state to look for. Step counts read the live
  `maxDeliveries` from `GET /api/dlq/config` instead of duplicating the config panel's default.
  All five outcome scenarios were **measured, not reasoned about** (see the table in
  [`specs/dlq.md`](specs/dlq.md)); the measurement changed the copy in one place worth keeping: the
  click that routes a message to the DLQ answers `success:false` / "No messages available to process"
  and paints a **red** banner, so the panel names that banner as the sweep rather than a failure.
  Guarded by 8 service specs + 8 component specs (frontend suite 18 → 34), and the OnPush guard was
  proven by injecting the in-place-mutation regression and watching 7 cases go red, 5 of them DOM
  assertions. Verified in a browser through the full 4-click walkthrough: DLQ `1 of 1 messages`,
  0 console errors. Generalising to the other 11 pages is deliberately **not** done — revisit once
  the format has been shown to a prospect.
- ✅ **DLQ legibility, round two** — *done 2026-08-25*, four author-requested changes:
  1. **A dead-lettered entry now says why.** `read_claim_or_dlq` appends `reason` + `originalId`
     (same field names as `LlmRecoverySweeper`), rendered as a line in the message header. Measured on
     the stack: a timeout sweep writes `max deliveries (2) reached`, a FATAL nack
     `poison (XNACK FATAL): delivery counter forced to max`.
     **Trap found by looking at the screenshot, not by reasoning:** gating that line on `reason` alone
     labelled a *healthy* main-stream entry as dead-lettered, because the page's own generated
     `order.cancelled` payloads carry a business `reason` (`customer_request`, `fraud_detected`). The
     line is now gated on `originalId`, which only the sweep writes. First `stream-viewer` spec file
     ever, and the guard was proven by re-introducing the fault (1 case red, the right one).
  2. **A failed row says how it failed.** New typed `DLQEvent.failureKind`
     (`TIMEOUT` / `EXPLICIT_FAIL` / `POISON` / `RELEASED`) rather than a match on the `details` string;
     the viewer badges `⏱ timeout` / `⚡ explicit fail`, and skips `POISON`/`RELEASED` because the
     delivery counter already renders those. An `XACK` clears the kind.
  3. **The status line is readable and honest.** 10 s instead of 3 s, and one shared timer instead of
     one per call — with per-call timers an earlier timeout wiped a status posted 2 s later, which 10 s
     would have made trivial to hit. A failing outcome is now **red**: `NO_ACK`/`NACK_FAIL`/`NACK_FATAL`
     return `success:true`, so colouring by the HTTP flag printed "processing failed" in green.
     `NACK_SILENT` stays green — a graceful release refunds the budget, nothing failed.
  4. **`window.confirm` is gone**, replaced by `ConfirmDialogComponent`: in-house rather than
     `MatDialog`, because `@angular/material` is a dependency used nowhere and the first use would drag
     a global theme into an entirely hand-styled app. Cancel focused on open, Escape cancels, backdrop
     deliberately not click-to-dismiss.

  Frontend suite **34 → 49**, lint 0, `luacheck` 0/0, backend `mvn clean test` **139 tests, 0 skipped**.
  Verified in a browser end to end: both reason strings on the DLQ side, `⏱ timeout` and
  `⚡ explicit fail` badges on the source side, banner still visible at 9 s and gone by 11 s, dialog
  opening with Cancel focused and closing on Escape, 0 console errors.
- ✅ **Per-Key Serialized: the guarantee now jumps out** — *done 2026-08-25*. `PerKeyLanesComponent`
  renders one row per second and one column per worker, each cell tinted by key, so two cells of the
  same colour in one row is the failure the lock exists to prevent. Judgement is **interval overlap**
  in `slot-model.ts` (16 pure-function tests, no clock), never slot collision; occupancy travels on a
  new `PerKeySlotEvent` (`STARTED` / `FINISHED` / `LOCK_SKIPPED`) emitted from
  `PerKeySerializedService.processEntry`, with `STARTED` **before** the 4s sleep so a running job is
  visible while it runs. Measured walkthrough and full acceptance table in
  `docs/specs/per-key-serialized.md`: 0 rows with a repeated colour, 10 of 40 rows with more than one
  worker busy, 11 refusal markers, `0 overlaps`, clean console.
  **The detector was proven able to fail — and the plan's recipe for it was wrong.** Lowering
  `RECLAIM_MIN_IDLE_MS` below the processing time does not breach *this* pattern: the early claimant
  meets a live lock and is refused, which is the pattern working. `LOCK_TTL_MS` has to drop below the
  work time too, so the holder's lock expires mid-work and a peer legitimately acquires it. At
  1000 ms each against 4000 ms of work the grid showed `1 overlap` and four red rows; both constants
  are back at 30000 / 10000 and the re-run returned to `0 overlaps`. So the grid *does* double as a
  correctness check for the failure mode that shipped 120 duplicated jobs in the Work Queue — and on
  that same breached run a slot-collision detector flagged 5 rows where interval judgement flagged 4,
  the two extras being legitimate hand-offs inside one second.
- ✅ **LLM Chat: token-by-token streaming really did arrive as one block — root cause found and fixed
  2026-08-28.** The author was right and the 2026-08-25 verdict below was wrong. Cause: the per-cid
  re-subscription that tells the server which conversation to stream lives *inside*
  `getConnectionStatus().subscribe(...)`, and that observable was a plain `Subject`. The service is a
  root singleton, so on **SPA navigation** the socket was already open, the callback never fired, no
  cid subscription was sent, and the reply arrived only via the 1500 ms REST poll. Measured on the
  pre-fix build: **169** DOM repaints over ~7s on a cold load vs **7** (largest jump 1479 chars) when
  the page was reached by clicking the sidebar; after the one-line fix (`Subject` →
  `BehaviorSubject(false)`), **171** on both. Same fix closes the per-Key badge bug below — one cause,
  two symptoms.
  **Why the sweep missed it, and the lesson:** its four cases varied the *prompt* and the *internals
  panel* and held the entry path constant — every case was a direct page load. A sweep that varies two
  irrelevant dimensions and none of the relevant one proves nothing, however carefully it is measured.
  The 165-vs-6 paint difference it did find was real and sent the investigation after the wrong
  suspect (`MockLlmClient`'s `long text` keyword).
  *Historical record of that investigation, kept because its measurements are still valid for the
  cold-load path:* **Not reproducible — closed 2026-08-25 after a four-case sweep**, and the earlier
  2026-08-21 measurement stands. The sweep drove the real page with a `MutationObserver` in-page (so it records
  what the browser repaints, not what a poll samples) across the cases the first measurement missed:

  | Case | Prompt | Internals | 1st char | Length | Distinct paints | Largest jump |
  |------|--------|-----------|----------|--------|-----------------|--------------|
  | A | `hello` | closed | 578 ms | 40 | 6 | 10 |
  | B | `hello` | open | 96 ms | 40 | 6 | 10 |
  | C | `long text please` | closed | 112 ms | 1040 | 165 | 16 |
  | D | `long text please` | open | 100 ms | 1040 | 165 | 16 |

  Every case streams (`singleBlock: false`), 0 console errors. The 165 paints vs the earlier 23 are
  finer sampling, not a contradiction. **The likely origin of the report:** `MockLlmClient` routes to
  `LONG_REPLY` only when the prompt contains `long text` (line 73); any other prompt yields ~40
  characters painted in 6 steps over ~220 ms — real streaming that no human eye can resolve. It
  *appears*, it does not *type*. Neither suspect (`tokenDelayMs`, the 1500 ms `refresh()` poll racing
  `ASSISTANT_MESSAGE`) was implicated.
  → Remaining, and **not** acted on because it was outside the validated scope: `long text` is an
  undiscoverable magic word in the input field. The `longTextDemo()` button exists, but nothing tells
  an operator typing a prompt that a short reply is the reason streaming looks instant.

## Found while naming the DLQ scenario (2026-08-25)

- ✅ **A dead-lettered entry now names the button that put it there.** `failedVia`
  (`NO_ACK,NACK_FAIL`) travels to the sweep as an **optional 6th ARGV** — never a new KEY, because five
  other services and the blog post's six language samples call `read_claim_or_dlq` with exactly 2 keys
  and 5 args and must keep working untouched. The backend owns the history (only it knows the button;
  the Lua sees a counter), the frontend owns the labels (`Process & Fail (timeout) ×2 — max deliveries
  (2) reached`), consecutive repeats collapse to `×N` and a mixed run is spelled out with `→`.
- 🔴→✅ **`XNACK SILENT` does not reset the delivery counter to 0 — it refunds its OWN delivery.**
  Measured with `XPENDING`, `maxDeliveries=2`: five consecutive releases keep the counter at 0 and never
  reach the DLQ, but a `NO_ACK` **followed by** a `SILENT` leaves it at **1**, and an alternating
  `NO_ACK`/`SILENT` loop is dead-lettered on the second pair. Three things were wrong because of this
  belief, all fixed:
  1. `DLQMessagingService` hardcoded `counterAfter = 0` for `NACK_SILENT`, so the UI was told the retry
     budget was empty while Redis held a charged attempt. It now reads `XPENDING`.
  2. The narration panel claimed the message "never reaches the DLQ, however often you repeat this".
     It now names its precondition (a *pure* release loop) and points the operator at the mixed case.
  3. Clearing the failure history on `SILENT` made a swept entry report **one** failure for **two**
     clicks. Only actions that charge the budget are recorded, so `failedVia` mirrors the counter.

  **Why the belief survived:** `DLQXnackIntegrationTest#nackSilent_refundsCounter` only ever released a
  message on its *first* delivery, where the counter genuinely lands on 0 — a true assertion that does
  not generalise. New test `nackSilent_afterAChargedAttempt_refundsOnlyItsOwnDelivery` closes the gap,
  and `sweptEntry_recordsTheActionsThatChargedTheBudget` pins the ordered mixed history.
  Backend **139 → 141 tests**, frontend **49 → 52**, all green, 0 skipped; verified in a browser across
  the timeout / mixed / poison sweeps with 0 console errors.
- ✅ **Right column tightened, left column shows progress** — *done 2026-08-25*, three author-requested
  changes:
  1. **The DLQ origin is a short header badge**, `⚠ Timeout ×2` / `⚠ Poison` /
     `⚠ Timeout → Explicit fail`, with the mechanism and the original id on hover. Terse on purpose —
     inside a DLQ, "fail" is a given.
  2. **Cards resized rather than trimmed** — *revised on author feedback the same day*. The first
     attempt hid the sweep's three fields to free the lines; the requirement was the opposite: keep
     every row and make the card bigger. The viewer shows what the stream holds, so the header badge
     now summarises without replacing. DLQ viewer `[messageHeight]="205"` (source column keeps 125),
     six rows rendered, `scrollHeight - clientHeight = 0`.
     **Column height 861, measured rather than estimated.** Card pitch is **127px** (125 + a 2px gap),
     the container adds 16px of padding, header plus footer cost **85px**: `6 × 127 − 2 + 16 + 85`.
     Two guesses (755, 835) each left the sixth card cut off; only measuring the gap and the padding
     closed it. Now `clientHeight == scrollHeight == 776`, six of six cards fully visible.
  3. **Any attempted message stays dimmed** (`handled`, opacity `0.38`) instead of only flashing —
     failure as well as success, because a failed attempt is still an attempt and what a viewer needs is
     how far down the stream the demo has got. A success additionally carries the `acked` badge;
     `MESSAGE_PROCESSED` has exactly one emitter (this page's ACK path) and the entry is XACKed straight
     after, so the state is accurate.
  4. **Generate Messages now produces six entries**, not four: with `maxDeliveries` at 2 a single
     scenario burns three clicks, so four ran out mid-demonstration. The narration copy counts them
     too, so the panel and the button cannot drift apart.

  **Found while measuring, not requested:** the freshly processed card showed `2×` *and* `acked` — a
  delivery count on an acknowledged entry, two statements that cannot both be true. The success event is
  broadcast *before* the XACK lands, so a pending poll in flight reads the stale row.
  `refreshPendingInfo` now leaves acked entries alone; guarded by a spec that needed its own
  group-aware setup (without a consumer group the poll returns early and the guard was untestable), and
  proven by removing the guard and watching the failure print `2×`.
  Frontend **52 → 55 tests**, lint 0, 0 console errors in the browser walkthrough.

- ✅ **"2 more messages" was neither clickable nor accurate** — *done 2026-08-25*, reported by the
  author as "the 2 hidden messages can't be processed". **They could**: with 12 messages and a window of
  10, 12 consecutive ACKs consumed all 12 distinct ids and left the PEL at 0. The real defect is an
  ordering mismatch — the viewer shows the **newest** `pageSize` entries (`XREVRANGE ... COUNT`) while a
  consumer group delivers the **oldest undelivered** first, so beyond the window the next message to be
  processed is off-screen *by construction* and a click changes nothing visible.
  Three findings, all fixed:
  1. `.more-messages` **has never had a click handler.** There is no broken pagination; there is no
     pagination. It is now written as information, with the ordering spelled out in the line and in its
     tooltip, instead of looking like a control.
  2. The count was `totalMessages - pageSize`, right only while the list happens to be full. A trim
     (`MESSAGE_DELETED`) made it understate — 4 held, 2 shown, and it claimed 1 hidden. Now
     `totalMessages - displayedMessages.length`, pinned by a spec that drives exactly that divergence.
  3. `pageSize` 10 → **20** on both DLQ columns, as requested: Generate produces six, so three clicks
     stay inside the window. Verified — two clicks give `12 of 12 messages` with no indicator, and all
     12 rows end up visibly marked after twelve successes.

- ✅ **The committed frontend bundle in `src/main/resources/static/` is deleted** — *done 2026-08-28*,
  12 files / 592 KB. **"Nothing serves it" was wrong**: Spring Boot's default static handler does, and
  with `context-path: /api` it was reachable at `http://localhost:8080/api/` — a stale copy of the app
  on the backend port, which its own `base href="/"` then loaded broken (chunks requested from `/`,
  outside the context path). Not dead weight; a second, wrong app. Verified after removal:
  `GET :8080/api/` → **404**. It also polluted every code search — it is what matched
  `read_claim_or_dlq` in minified JS.

## Found while closing the CORS / URL / cleanup batch (2026-08-28)

- ✅ **`WebSocketService.connectionStatus` was a `Subject`, so late subscribers never learned the
  socket was open** — *fixed 2026-08-28*, one line to `BehaviorSubject<boolean>(false)`. Reported by
  the author as "the per-key websocket badges say disconnected, everywhere else it works". It is
  **not** a regression from this batch: `git show HEAD:` confirms the pre-change `per-key-lanes` had
  no seeding and the pre-change service used the same plain `Subject` — the bug shipped with the grid
  in `a6a3876` (PR #30). Reproduced deterministically and fixed; see the `BehaviorSubject` entry in
  `CLAUDE.md` for the mechanism and both symptoms.
- 🟡 **The test suite could not have caught it: `WebSocketServiceStub` was more capable than the
  service.** The stub's `connection` is a `BehaviorSubject`, the real one was a `Subject`, so all 13
  spec files were written against a source that replays — the failure mode was unreachable by
  construction. `websocket.service.spec.ts` now pins the two contracts together (3 cases; all three
  fail on the pre-fix service, with `[]` where the stub yields one value). → **Audit the other stubs
  for the same drift.** `src/app/testing/` is small today, but every capability a stub adds beyond its
  subject is a blind spot with a green test next to it.
- 🟡 **Two verification methods used in this project have now produced a false "healthy".** Recorded
  so they are not repeated: (1) counting connection badges with `/live|Connected|connected/i`, which
  matches **Dis**connected — it reported `/per-key-serialized` healthy while 3 of its 4 badges were
  red; (2) a `MutationObserver` probe that tracks "the last leaf element longer than 20 chars", which
  reported 2 repaints where a selector-free probe on the transcript's total length found 171. →
  Prefer selector-free, whole-subtree measurements, and assert on *exact* strings, never a substring
  that another state contains.
- 🟡 **Browser verification must reach the page the way a user does.** Every UI check in this repo so
  far used `page.goto(route)` — a cold load. Both bugs above exist **only** on SPA navigation, because
  the socket is already open by then. The 12-page walkthrough should click the sidebar, not re-navigate.

- 🟡 **`PerKeySerializedIntegrationTest#jobsOnDifferentKeysRunInParallel` is load-flaky.** It timed
  out once in a full `mvn clean test` (class elapsed **117s**), then passed in isolation (**59.9s**)
  and in an immediate full re-run (**160 tests, 0 failures, 0 skipped**). It asserts a 60s wall-clock
  deadline on three distinct-key jobs, so it fails when the machine is busy rather than when the code
  is wrong — and the suite now carries one more Redis container's worth of load than when that
  deadline was chosen. Not caused by this batch (nothing here touches `PerKeySerializedService`), but
  it will redden CI at random. → Either raise the deadline, or assert the *ordering* rather than the
  elapsed time, the way the per-key grid does.
- 🟡 **`README.md` still described the demo's CORS as "open"** in its security warning — untrue since
  PR #3 (2026-06-29) locked it to an allow-list. Corrected 2026-08-28 in the same pass; flagged here
  because it is the second stale claim found in a doc this week, after the CI job name that read
  `139` for two suite growths. A statement of *current posture* in prose rots exactly like a test
  count does.

## Code review & security

- ✅ **First full `/code-review`** (2026-06-29) — findings tracked in
  [`specs/code-review-findings.md`](specs/code-review-findings.md); P1/P2 fixes shipped in PR #2
  (Redis/pattern correctness, dedicated pub/sub connections, CORS allow-list, Lua loader hardening,
  inline `EVAL` → registered functions). Remaining follow-up: extract a typed decoder for `fcall`
  replies (readability of the critical paths).
- ✅ **First full `/security-review`** (2026-06-29) — no exploitable vuln beyond the by-design no-auth
  posture; the two concrete origin/sink gaps (WebSocket origin, Mermaid `innerHTML`) fixed in PR #3.

## Docs

- ✅ Addressed in that pass (2026-06-26): `docs/` (PRD, architecture, specs, ADRs, migration-status),
  root `CLAUDE.md`, and README pattern list sync (see `/doc-sync`).
- 🟡 `augmentcode/CONTEXT.md` & `IMPLEMENTATION_REFERENCE.md` describe only the original 4 patterns
  and legacy stream names (`test-stream`). Kept for history; `docs/` supersedes them.
