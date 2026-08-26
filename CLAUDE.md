# CLAUDE.md — Redis Messaging Patterns (entry map for agents)

> Global engineering standards live in `~/.claude/CLAUDE.md` and apply here unchanged.
> This file is the **project-specific** entry map. Keep it current when behavior changes.
> Tags: items marked **(inferred — verify)** were reconstructed from code, not stated by the author.

## What this is

An **educational demo** that showcases enterprise messaging patterns implemented on **Redis**
(Streams, Pub/Sub, Sorted Sets, Lua Functions) with a **Spring Boot + Jedis** backend and an
**Angular 21** single-page frontend. Each pattern has its own page that visualizes the Redis
data flow in real time over WebSocket. **Not production-ready** — it favors clarity and
observability over hardening.

## Stack (verified from `pom.xml` / `frontend/package.json`)

| Component | Version | Notes |
|-----------|---------|-------|
| Java | 21 | Virtual Threads used heavily |
| Spring Boot | 4.1.1 | Spring Framework 7; Web, WebSocket, Actuator, Validation |
| Jedis | 8.0.0 | Direct `JedisPool`, no Spring Data Redis; **typed `xnack(..., XNackMode, ...)`** (the raw `sendCommand` workaround is gone) |
| Redis | 8.8-alpine | **8.8+ required** for `XNACK` (explicit NACK); `XREADGROUP ... CLAIM` itself needs 8.4+ |
| Angular | 22 | Standalone components, lazy routes, Angular Material; TypeScript 6.0; `@angular/build` (esbuild) |
| Realtime | SockJS + raw WebSocket | endpoint `/api/ws/dlq-events` |
| Diagrams | mermaid 11 | per-pattern flow diagrams in the UI |
| JSON | Jackson **3** (`tools.jackson`) | the Boot 4 default; annotations stay `com.fasterxml.jackson.annotation` (ADR-0013) |

## How to run (verified)

- **Docker (only fully-working path in this VM):** `./launch-docker.sh --build`
  → frontend http://localhost:4200, backend http://localhost:8080/api, RedisInsight :5540.
  **Every launch starts from an empty Redis** (ADR-0012): the container is ephemeral (no volume,
  `--save "" --appendonly no`) *and* the script `FLUSHALL`s between `stop backend` and `up -d`, so
  the groups are recreated against the empty keyspace. `--keep-data` opts out. RedisInsight connects
  to host `redis-messaging-redis` (or `redis`), port 6379, no password — **not** `localhost`, which
  inside that container is RedisInsight itself.
- **Backend locally:** **Java 21 + Maven now installed in this VM** (Temurin/OpenJDK 21.0.11,
  Maven 3.9.16) — `mvn compile` / `mvn package` work directly. Docker remains the canonical path
  (multi-stage `Dockerfile`, `maven:3.9-eclipse-temurin-21-alpine`). Lua functions auto-load on startup.
- **Frontend locally:** `cd frontend && npm ci && npm start` (VM runs **Node 24.16**, npm 11). `npm ci` is
  required in this VM — a host-installed `node_modules` carries the wrong `esbuild` native binary (darwin vs linux).
- **Lua lint:** `luacheck lua/ --globals redis cjson cmsgpack bit` (luacheck 1.2.0, Lua 5.1) →
  **0 errors, 0 warnings** across both files — measured 2026-08-25.
- **Backend tests:** `mvn clean test` — **148 tests, all 12 patterns covered**. Integration tests use a
  real Redis (8.8) started via the **docker CLI** (`support/AbstractRedisIntegrationTest`), not
  Testcontainers — the bundled docker-java negotiates Docker API v1.32, which this engine (min v1.40)
  rejects. Tests **skip** (not fail) when Docker is unavailable — a run where they skip is not a green
  run. **The suite takes ~4 minutes**; that is not a hang: `TokenBucketIntegrationTest` (117s) and
  `PerKeySerializedIntegrationTest` (50s) assert timing-based guarantees against the services' real
  4–10s simulated work. Writing a new pattern test? Two traps: (1) `mvn test` without `clean` fails
  with bogus "cannot be resolved" errors in this VM, and (2) any service that calls `fcall` needs
  `functionLoadReplace(Files.readString(Path.of("lua/stream_utils.lua")))` in `@BeforeEach` — without
  it Per-Key's `release_lock` silently fails and every lock survives to its 30s TTL.
- **Frontend tests:** `cd frontend && npm test` → **91 tests** (Vitest via `@angular/build:unit-test`,
  target in `angular.json`, `tsconfig.spec.json` so specs are type-checked — without it the builder
  bundles them unchecked). Four traps, all measured, do not rediscover them:
  1. **Never `fixture.detectChanges()` in a change-detection spec.** It checks the view
     unconditionally and hides the very bug you are guarding against. Use
     `fixture.autoDetectChanges(true)` + `settle()` (`src/app/testing/change-detection.ts`).
  2. **`fixture.whenStable()` never resolves** for a component owning a recurring timer — LLM Chat
     polls REST every 1500 ms, so the spec times out at 5s.
  3. **`vi.useFakeTimers()` freezes Angular's scheduler**: signals update, the DOM stays stale, every
     case fails for the wrong reason.
  4. **jsdom has no WebSocket** — always inject `WebSocketServiceStub`, never let a spec build SockJS.
  5. **Never assert "the view grew after waiting N ms" for a component with a recurring tick.** Wall
     time does pass in these specs (`Date.now()` advances normally — measured), but the tick's phase is
     fixed at component *init*, not at the event under test, so waiting one interval can advance the
     clock by less than one interval (measured: 948 ms after a 1300 ms wait). Assert the rendered
     *rule* (`data-clock` on `per-key-lanes`) instead; a *frozen* clock is the only exact direction,
     because nothing may advance at all.
- **CI:** `.github/workflows/ci.yml` — three jobs on every PR and every push to `main`: **backend**
  (Java 21, `mvn clean test`, then a gate that **fails if any test was skipped**), **frontend**
  (`npm ci` → lint → `npm test` → build → `npm audit --audit-level=moderate`), **lua** (`luacheck`,
  zero warnings tolerated). The skip gate is the point: the Redis integration tests *assume themselves
  away* without Docker, so a runner without it would go green having tested almost nothing. It also
  floors the total at 100 tests — raise that floor deliberately, never lower it by accident. Not
  covered: the browser-mode layout rule (slice C of the frontend-test-runner spec) and the 12-page
  browser walkthrough, both still manual.
- **Lint:** `cd frontend && npm run lint` → **0 errors** (was 145 under angular-eslint 22). Keep it
  there: templates use the built-in control flow (`@if`/`@for`, not `*ngIf`), every `<label>` is
  associated with its control (a caption that labels a *group* is a `<span class="group-label">`, not a
  label), clickable non-button elements carry `role`/`tabindex`/`keydown`, and **components are
  `ChangeDetectionStrategy.OnPush`** — put mutable template state in a `signal()`, and **replace** its
  value rather than mutating it in place, or the view will not refresh. Guarded by
  `pubsub-subscriber.component.spec.ts`, `llm-chat.component.spec.ts` and
  `dlq-narration.component.spec.ts`; all three were verified by injecting the bug and watching them go
  red (the narration one fails 7 cases, 5 of them DOM assertions). Note the failure only shows when *no* other signal is
  written in the same turn — a co-located signal write marks the view dirty and repaints the broken
  field along with it, which is why `dlq-actions` cannot be guarded this way.

## Layout

- `src/main/java/com/redis/patterns/` — backend: `controller/`, `service/`, `config/`, `dto/`, `websocket/`
- `lua/stream_utils.lua` — all 7 registered Redis Functions (`read_claim_or_dlq`, `request`, `response`, `route_message`, `acquire_token`, `release_token`, `release_lock`)
- `frontend/src/app/components/<pattern>/` — one Angular component per pattern page
- `frontend/src/app/services/` — `redis-api`, `websocket`, `stream-refresh`, `routing-rules`, `diagram-definitions`, `llm-chat`
- `service/llm/` — pattern #12 LLM abstraction (`LlmClient`, `MockLlmClient`); orchestration in `LlmChatService` + `LlmResponderWorker` + `LlmTokenListenerService`
- `blog/<slug>/` — the blog series: `index.md` (+ `index.fr.md`), `img/`, `samples/` (6 runnable
  languages), `verify.sh` (the post's acceptance harness — one command, own throwaway Redis).
  Publication is a **pinned tag** per post: see [`blog/PUBLISHING.md`](blog/PUBLISHING.md).
  Shipped: `dlq-redis-streams` (`blog-dlq-v1`), `work-queue-redis-streams` (`blog-workqueue-v1`).
- `docs/` — agent-facing docs (this map points into them)
- `augmentcode/` — **legacy** agent notes (covers only the first 4 patterns; superseded by `docs/`)

## The 12 patterns (route → primary Redis structure)

| Page route | Pattern | Redis structure | Key streams/keys |
|------------|---------|-----------------|------------------|
| `/dlq` | Dead Letter Queue | Streams + Consumer Groups + Lua; **XNACK explicit failure** (Redis 8.8): `FAIL` = immediate retry (budget kept), `FATAL` = poison → DLQ next poll (counter = Long.MAX), `SILENT` = the current delivery refunded (earlier charges stand). `POST /process {outcome}` (legacy `{shouldSucceed}` still mapped). **Narration band** (`DlqNarrationComponent` + `DlqScenarioService`) states per click what is being demonstrated and what steps remain. Swept entries carry **`reason` + `originalId`**; source rows carry a **`failureKind`** badge | `test-stream`, `test-stream:dlq` |
| `/pubsub` | Publish/Subscribe (QoS0) | Pub/Sub channels | `fire-and-forget` |
| `/request-reply` | Request/Reply | Streams + keyspace-expiry timeout | `order.holdInventory.v1(.response)` |
| `/work-queue` | Work Queue (competing consumers) | Streams + 1 group, **1-8 workers adjustable at runtime** (4 at startup, in-memory); `POST`/`DELETE /workers` (`?kill=true` leaves the in-flight job PENDING — crash-recovery demo, never `XGROUP DELCONSUMER`); **`PUT /demo-mode?mode=SLOW\|FAST`** retimes the running pool (work time + `minIdle` + poll, `FAST` at startup); `POST /produce/burst?count=N` (pipelined `XADD`) builds the backlog the UI's jobs/s counter needs — the steady producer alone never does | `jobs.imageProcessing.v1`, `jobs.done.worker-{1..N}` |
| `/fan-out` | Fan-Out (broadcast) | Streams + **N groups** | `fanout.events.v1` |
| `/topic-routing` | Topic Routing (stream) | Lua `route_message` + rule hashes | `events.topic.v1` → `events.*` |
| `/pubsub-topic-routing` | Topic Routing (Pub/Sub) | `PSUBSCRIBE` patterns | `order.<region>.<event>` |
| `/content-routing` | Content-Based Routing | Streams + amount thresholds | `payments.incoming.v1` → tiers |
| `/scheduled-messages` | Scheduled/Delayed Messages | Sorted Set + Hash + Stream | `scheduled.messages`, `reminders.v1` |
| `/per-key-serialized` | Per-Key Serialized | Stream + `SET NX` lock per key; **time-slot grid** (`PerKeyLanesComponent`): one row per second × one column per worker, cell tinted by key, so two cells of the same colour in a row is the breach. Fed by **`PerKeySlotEvent`** (`STARTED` before the 4s sleep / `FINISHED` / `LOCK_SKIPPED`); violations judged on **interval overlap** in `slot-model.ts`, never slot collision; each cell names its **action** beside the key, and the **clock only ticks while a job is in flight** (`data-clock` / `▶ live` vs `⏸ stopped`) so an idle page stops growing rows | `jobs.perkey.v1`, `running:order:{id}` |
| `/token-bucket` | Token Bucket (concurrency cap) | Stream + Lua counter | `token-bucket.jobs.v1` |
| `/llm-chat` | LLM Chat (Streams) | Stream + **3 groups** (`cg:responder`/`cg:moderation`/`cg:analytics`, fan-out) + per-conv token stream; RedisTimeSeries analytics; **`XAUTOCLAIM` recovery sweeper + DLQ** (kill-worker/`/fail` poison demos); **reply timeout via keyspace notifications** (ADR-0010); **conversation persists across page reload** (frontend keeps the cid in `localStorage` → `chat:{cid}` is the source of truth) | `chat:{cid}` (cid=`companyId:userId`), `chat:{cid}:tok`, `chat:{cid}:flags`, `chat:{cid}:stats`, `ts:{cid}:userTokens`, `chat:{cid}:dlq`, `llm:timeout:{msgId}`(+`:shadow`) |

Full contracts: `docs/specs/<pattern>.md`. System design: `docs/architecture/overview.md`.
Decisions & rationale: `docs/adr/`. Open issues: `docs/TODO.md`.

## Cross-cutting facts agents must know

- **Context path is `/api`** — every REST path and the WebSocket endpoint are prefixed with it.
- **Lua auto-loads** on startup via `RedisLuaFunctionLoader` (`@PostConstruct`, replaces the library).
- **Stream visualization uses `XREVRANGE`** (read-only, no PENDING side effects); **processing uses
  `XREADGROUP`/Lua**. Don't read groups for display — it creates phantom pending entries.
  **Consequence to keep in mind (measured 2026-08-25):** the viewer shows the **newest** `pageSize`
  entries while the group delivers the **oldest** first, so once a stream exceeds the window the next
  message to be processed is off-screen and a Process click looks like a no-op. Nothing is unreachable
  — 12 ACKs did consume all 12 of 12 messages — but the feedback is invisible. `stream-viewer` has **no
  pagination** (the `.more-messages` line never had a click handler); the DLQ page and Per-Key's
  incoming viewer therefore use `pageSize=20`, and that line now states the ordering instead of
  pretending to be a control.
- **`/dlq/messages` returns `streamLength` (the real `XLEN`) beside `count` (the size of the page), and
  the viewer counts against the former.** `count` is capped by the requested page size, so a window
  holding 5 of 11 entries reported 5 and the footer read **"5 of 5 messages"** — the truncation was
  not merely unpaginated, it was *denied*. `hasMoreMessages` was stored derived state, initialised
  `false` on load ("we don't know the total yet") and only flipped true when a live event pushed a row
  off the bottom, so a stream already longer than the window when the page opened never showed the
  "older entries not shown" line at all. It is now a **getter** over `totalMessages >
  displayedMessages.length`; derived state that cannot go stale. Found on `/per-key-serialized`
  2026-08-25, where the hidden entries were the five `#1001` jobs the page exists to demonstrate.
  Guarded by `DLQMessagesTruncationTest` and `stream-viewer-truncation.component.spec.ts`. Any new
  caller of `getMessages` must treat `streamLength` as **optional** and fall back to `count`.
- **`MESSAGE_ACKED` / `MESSAGE_PROCESSED` vs `MESSAGE_DELETED`.** There is **no `XDEL` anywhere in this codebase**: a
  worker finishing a message `XACK`s it and the entry stays in the stream. Workers therefore emit
  **`MESSAGE_ACKED`**, and `stream-viewer` marks the row (dimmed + `acked` badge) without touching
  `totalMessages`. **`MESSAGE_DELETED` has exactly one legitimate emitter** — `StreamMonitorService`,
  which diffs seen ids against the ids a stream still holds. Emitting it after an `XACK` is what made
  the viewer read `0 of 199 messages` against an `XLEN` of 200. **Any attempted row is dimmed** (`handled`,
  opacity 0.38) — failure as well as success, so an operator can see how far down the stream they have
  got; `MESSAGE_PROCESSED` (one emitter: the DLQ page's ACK path) adds the `acked` badge on top — and `refreshPendingInfo` skips acked rows, because the event is broadcast before the
  `XACK` lands and a poll in flight would otherwise re-add a `2×` badge next to `acked`.
- **A DLQ entry says why it is there** (2026-08-25). `read_claim_or_dlq` appends `reason`
  (`max deliveries (N) reached` / `poison (XNACK FATAL): …`) and `originalId` to every swept copy,
  matching `LlmRecoverySweeper`'s field names. **Gate any "why was this dead-lettered" UI on
  `originalId`, never on `reason` alone**: the DLQ page's own generated `order.cancelled` payloads carry
  a *business* `reason` (`customer_request`, `fraud_detected`), and keying off the name labelled a
  healthy main-stream entry as dead-lettered. Guarded by `stream-viewer.component.spec.ts`. Note the
  blog post `blog/dlq-redis-streams` quotes this Lua function but is published against the pinned tag
  `blog-dlq-v1`, so readers are unaffected until it is re-tagged.
- **Per-key worker occupancy travels on `PerKeySlotEvent`, not `DLQEvent`** — a fourth
  `WebSocketEventService.broadcastEvent` overload, `eventType` always `PER_KEY_SLOT`. `DLQEvent` is
  consumed by `stream-viewer` on all twelve pages and its payload (payload / deliveryCount /
  failureKind) says nothing about which worker holds which key; same precedent as `PubSubEvent`. Its
  `atMs` is **epoch millis, not a formatted timestamp**, because the grid does arithmetic on it — slot
  binning and interval comparison. Two rules the model exists to enforce: a violation is **overlap of
  two runs' `[start, end)` intervals on one key**, never two cells landing in the same slot (measured
  2026-08-25: on a deliberately breached run, slot collision flagged 5 rows where interval judgement
  flagged 4 — the extras were hand-offs inside one second), and an interval **floors at one slot**, or
  a job whose `STARTED` is the newest event has zero width, paints no cell and overlaps nothing.
  **Breaching this pattern on purpose needs `LOCK_TTL_MS` below the work time, not just
  `RECLAIM_MIN_IDLE_MS`** — an early claimant meeting a live lock is refused, which is the pattern
  working.
- **`DLQEvent.failureKind`** (`TIMEOUT` / `EXPLICIT_FAIL` / `POISON` / `RELEASED`) is the typed way to
  ask how an attempt failed — do not string-match `details`. Only `TIMEOUT` and `EXPLICIT_FAIL` get a
  row badge; the other two are already rendered from the delivery counter.
- **XNACK semantics (Redis 8.8, verified empirically):** a released message stays in the PEL but
  **unowned** (`consumer` empty, `idle = -1`) and is immediately re-claimable (bypasses `minIdle`).
  Counter: `FAIL` → kept, `FATAL` → `Long.MAX`, **`SILENT` → refunds its OWN delivery only** —
  0 when nothing was charged before it, but a `NO_ACK` followed by a `SILENT` leaves the counter at
  **1** (measured 2026-08-25). So "budget refunded" does not mean "clean slate": mixing Fail and
  Release still reaches the DLQ, and the backend used to hardcode `0` here, telling the UI the budget
  was empty while Redis said otherwise. `XREADGROUP >` does NOT re-deliver
  released messages — only the claim path does (`read_claim_or_dlq` uses `CLAIM`, unchanged).
  JSON precision: `Long.MAX` rounds in JS — the UI detects poison by threshold
  (`>= Number.MAX_SAFE_INTEGER`), never equality.
- **`minIdle` must outlast the simulated work time in every claim-based pattern.** If it doesn't, a free
  worker claims a job its busy peer is still processing and the job runs **twice, silently** (no error,
  empty PEL, empty DLQ). The work queue shipped 100 ms / 100 ms and duplicated **120 of 266** completed
  jobs in a live run; its `DemoMode` presets now enforce `minIdleMs >= 2 * workMs`. **Token Bucket and
  Per-Key Serialized are now audited** and clean — `TokenBucketIntegrationTest` and
  `PerKeySerializedIntegrationTest` assert no job is processed twice under saturation. Note Token
  Bucket's margin is thinner than the rule of thumb (`RECLAIM_MIN_IDLE_MS` 15s vs 10s for a CSV job =
  1.5x, not 2x) — it holds because it still exceeds the work time, so treat those two constants as
  coupled. The **LLM Chat sweeper remains unaudited** — see `docs/TODO.md`.
- **Maven incremental compilation is unreliable in this VM** (shared-mount mtimes): after editing
  Java sources, use `mvn clean test` — plain `mvn test` may say "Nothing to compile" or produce
  corrupted classes (`ClassFormatError: Truncated class file`).
- **Live UI updates** come from `RedisStreamListenerService` (one Virtual Thread per monitored
  stream, `XREAD BLOCK 1000`) broadcasting `DLQEvent`/`PubSubEvent` over WebSocket.
- **Several services clear their demo streams on startup** (`@Order`-sequenced runners) for a clean slate.
- **Redis keeps nothing between runs** (ADR-0012). Never flush under a running backend: `FLUSHALL`
  drops the consumer groups, which are created **only** in the services' `CommandLineRunner`s (or by the
  per-pattern `DELETE /api/<pattern>/clear`), so a live backend would then read groups that no longer
  exist. Flush order is `stop backend` → flush → start backend. `FLUSHALL` does *not* remove the Lua
  library (verified on redis:8.8).
- **LLM Chat data is durable & reset-only *within a run*:** unlike the other demo streams, LLM Chat
  does *not* clear on backend startup — but since ADR-0012 a **stack relaunch starts from an empty
  Redis**, so the conversation survives a page reload, not a `./launch-docker.sh`. `LlmChatService.reset(cid)` is the **only** deleter — a surgical `DEL` of
  `chat:{cid}` + `:tok`/`:flags`/`:stats`/`:dlq` + `ts:{cid}:userTokens` (no `flushall`). The
  frontend persists the cid in `localStorage` (`redis-llm-chat-cid`) so a reload restores the chat.
- **No auth** (by design — ADR-0008). **CORS and WebSocket origins are restricted to an explicit
  allow-list** (`CorsConfig` / `WebSocketConfig`, driven by `app.cors.allowed-origins`, default the
  local frontend/backend). Still not deployment-ready (no auth/TLS) — see ADR-0008 / TODO.
