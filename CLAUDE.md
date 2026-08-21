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
| Angular | 21 | Standalone components, lazy routes, Angular Material |
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
  0 errors, 1 cosmetic warning (long line) — measured 2026-07-31.
- **Backend tests:** `mvn clean test` — **93 tests**: LLM Chat (#12) + DLQ/XNACK
  (`DLQXnackIntegrationTest`, `DLQProcessControllerTest`) + Work Queue worker pool & demo modes
  (`WorkQueueScalingIntegrationTest`, `WorkQueueWorkersControllerTest`, `WorkQueueDemoModeTest`).
  Integration tests use a real
  Redis (8.8) started via the **docker CLI** (`support/AbstractRedisIntegrationTest`), not
  Testcontainers — the bundled docker-java negotiates Docker API v1.32, which this engine (min v1.40)
  rejects. Tests **skip** (not fail) when Docker is unavailable — a run where they skip is not a green
  run. The other 9 patterns have no tests yet.
- **Frontend tests:** still none — `angular.json` has no `test` target, so `ng test` has no builder. The
  `@angular/build:unit-test` builder (Vitest) is *already installed* as a transitive dep; setup is a
  1-line target + `npm i -D vitest jsdom`. Plan, traps and effort:
  [`docs/specs/frontend-test-runner.md`](docs/specs/frontend-test-runner.md).
- **Lint:** `cd frontend && npm run lint` → 76 pre-existing errors in older components (see
  `docs/TODO.md`); the `llm-chat` component/service are lint-clean.

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
| `/dlq` | Dead Letter Queue | Streams + Consumer Groups + Lua; **XNACK explicit failure** (Redis 8.8): `FAIL` = immediate retry (budget kept), `FATAL` = poison → DLQ next poll (counter = Long.MAX), `SILENT` = budget refunded. `POST /process {outcome}` (legacy `{shouldSucceed}` still mapped) | `test-stream`, `test-stream:dlq` |
| `/pubsub` | Publish/Subscribe (QoS0) | Pub/Sub channels | `fire-and-forget` |
| `/request-reply` | Request/Reply | Streams + keyspace-expiry timeout | `order.holdInventory.v1(.response)` |
| `/work-queue` | Work Queue (competing consumers) | Streams + 1 group, **1-8 workers adjustable at runtime** (4 at startup, in-memory); `POST`/`DELETE /workers` (`?kill=true` leaves the in-flight job PENDING — crash-recovery demo, never `XGROUP DELCONSUMER`); **`PUT /demo-mode?mode=SLOW\|FAST`** retimes the running pool (work time + `minIdle` + poll, `FAST` at startup); `POST /produce/burst?count=N` (pipelined `XADD`) builds the backlog the UI's jobs/s counter needs — the steady producer alone never does | `jobs.imageProcessing.v1`, `jobs.done.worker-{1..N}` |
| `/fan-out` | Fan-Out (broadcast) | Streams + **N groups** | `fanout.events.v1` |
| `/topic-routing` | Topic Routing (stream) | Lua `route_message` + rule hashes | `events.topic.v1` → `events.*` |
| `/pubsub-topic-routing` | Topic Routing (Pub/Sub) | `PSUBSCRIBE` patterns | `order.<region>.<event>` |
| `/content-routing` | Content-Based Routing | Streams + amount thresholds | `payments.incoming.v1` → tiers |
| `/scheduled-messages` | Scheduled/Delayed Messages | Sorted Set + Hash + Stream | `scheduled.messages`, `reminders.v1` |
| `/per-key-serialized` | Per-Key Serialized | Stream + `SET NX` lock per key | `jobs.perkey.v1`, `running:order:{id}` |
| `/token-bucket` | Token Bucket (concurrency cap) | Stream + Lua counter | `token-bucket.jobs.v1` |
| `/llm-chat` | LLM Chat (Streams) | Stream + **3 groups** (`cg:responder`/`cg:moderation`/`cg:analytics`, fan-out) + per-conv token stream; RedisTimeSeries analytics; **`XAUTOCLAIM` recovery sweeper + DLQ** (kill-worker/`/fail` poison demos); **reply timeout via keyspace notifications** (ADR-0010); **conversation persists across page reload** (frontend keeps the cid in `localStorage` → `chat:{cid}` is the source of truth) | `chat:{cid}` (cid=`companyId:userId`), `chat:{cid}:tok`, `chat:{cid}:flags`, `chat:{cid}:stats`, `ts:{cid}:userTokens`, `chat:{cid}:dlq`, `llm:timeout:{msgId}`(+`:shadow`) |

Full contracts: `docs/specs/<pattern>.md`. System design: `docs/architecture/overview.md`.
Decisions & rationale: `docs/adr/`. Open issues: `docs/TODO.md`.

## Cross-cutting facts agents must know

- **Context path is `/api`** — every REST path and the WebSocket endpoint are prefixed with it.
- **Lua auto-loads** on startup via `RedisLuaFunctionLoader` (`@PostConstruct`, replaces the library).
- **Stream visualization uses `XREVRANGE`** (read-only, no PENDING side effects); **processing uses
  `XREADGROUP`/Lua**. Don't read groups for display — it creates phantom pending entries.
- **XNACK semantics (Redis 8.8, verified empirically):** a released message stays in the PEL but
  **unowned** (`consumer` empty, `idle = -1`) and is immediately re-claimable (bypasses `minIdle`).
  Counter: `SILENT` → 0, `FAIL` → kept, `FATAL` → `Long.MAX`. `XREADGROUP >` does NOT re-deliver
  released messages — only the claim path does (`read_claim_or_dlq` uses `CLAIM`, unchanged).
  JSON precision: `Long.MAX` rounds in JS — the UI detects poison by threshold
  (`>= Number.MAX_SAFE_INTEGER`), never equality.
- **`minIdle` must outlast the simulated work time in every claim-based pattern.** If it doesn't, a free
  worker claims a job its busy peer is still processing and the job runs **twice, silently** (no error,
  empty PEL, empty DLQ). The work queue shipped 100 ms / 100 ms and duplicated **120 of 266** completed
  jobs in a live run; its `DemoMode` presets now enforce `minIdleMs >= 2 * workMs`. Token Bucket and the
  LLM Chat sweeper are **unaudited** for this — see `docs/TODO.md`.
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
