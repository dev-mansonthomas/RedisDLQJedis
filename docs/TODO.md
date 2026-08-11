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
- 🟡 `frontend/Dockerfile` adds `chmod -R a+r` on the nginx web root — benign (public static assets).

## Correctness / build

- 🟠 **XNACK via raw `Jedis.sendCommand`** (`DLQMessagingService.XnackCommand`) — **now unblocked
  (verified 2026-08-11): Jedis `8.0.0` is GA** (`maven-metadata.xml` `<release>8.0.0`) and ships the
  typed `xnack(String, String, XNackMode, StreamEntryID...)` with `XNackMode.SILENT|FAIL|FATAL`
  (`javap` on the 8.0.0 jar). Still no typed `RETRYCOUNT`/`FORCE`, which the demo does not use.
  → Bump `jedis.version` 7.5.3 → 8.0.0 and replace the raw `sendCommand` workaround; `XReadGroupParams`
  (`count`/`block`/`claim`) and `fcall` are unchanged between the two jars, so the other patterns should
  compile untouched. Needs its own slice + `mvn clean test` (added 2026-07-09, ADR-0011).
- 🟡 **Post #1's samples pin stale client versions** (found while planning post #2, 2026-08-11):
  `blog/dlq-redis-streams/samples/` uses NRedisStack `0.13.1` (latest **1.7.3**), Rust `redis` `0.32`
  (latest **1.5.0**, i.e. now past 1.0), go-redis `v9.21.0` (latest `v9.22.0`) and Jedis `7.5.3`
  (latest `8.0.0`); the Python/Node pins float and already resolve to the latest. They still run, so
  this is a chore, not a bug. → Bump in one pass **after** post #2 ships, and re-run
  `blog/dlq-redis-streams/verify.sh`; the NRedisStack and Rust jumps cross majors, so expect API edits.
- 🟠 **No frontend test runner** — `angular.json` has no `test` target (only `build`/`lint`/`serve`), so
  `npm test` fails, and there are **0 `*.spec.ts`**. Consequence: pure logic gets verified by driving a
  real browser (`computeRate()`, the "max 4 columns" grid rule) instead of by unit test. Good news
  (verified 2026-08-04): `@angular/build@21.0.0` is already installed and ships a `unit-test` builder
  whose default runner is Vitest, and it generates the TestBed bootstrap itself — so it is `npm i -D
  vitest jsdom` plus a 1-line target. → Full plan, traps and effort:
  [`specs/frontend-test-runner.md`](specs/frontend-test-runner.md).
  *(Backend side is done: 93 tests as of 2026-08-04 — LLM Chat + DLQ/XNACK + work queue. The "Running
  Tests" section of `augmentcode/startup_instructions.md` remains aspirational.)*
- 🟠 **No CI at all** — no `.github/` directory, so nothing enforces tests, lint or build on a PR, and the
  `git-pr-merge` flow waits on a CI that does not exist. → A workflow running `mvn clean test` +
  `npm run lint` + `npm test`; note the Redis integration tests **skip** without Docker, so a runner
  without Docker would go green while testing almost nothing. See
  [`specs/frontend-test-runner.md`](specs/frontend-test-runner.md) ("Adjacent, not included").
- 🟠 **Frontend lint: 76 errors** (`npm run lint`). Dominant categories: `@angular-eslint/template/
  label-has-associated-control`, `click-events-have-key-events` / `interactive-supports-focus`
  (a11y), `@typescript-eslint/no-explicit-any`, `@angular-eslint/no-empty-lifecycle-method`.
  8 are auto-fixable (`npm run lint -- --fix`).
- ✅ **Backend builds & runs locally in this VM** — *resolved 2026-06-29*: Java 21 + Maven 3.9.16
  are now installed (host VM provisioning), so `mvn compile`/`mvn package` work directly; the Docker
  multi-stage path also works. Lua lint available via `luacheck`.

### Toolchain inventory (required vs VM, updated 2026-06-29)

| Tool | Required (source) | VM | Status |
|------|-------------------|----|--------|
| JDK | 21 (`pom.xml`, Dockerfile temurin-21) | 21.0.11 | ✅ installed |
| Maven | 3.9 (Dockerfile `maven:3.9`) | 3.9.16 | ✅ installed |
| Node | 22 (frontend Dockerfile `node:22-alpine`) | 24.16.0 | 🟡 runtime VM is 24; build image still `node:22-alpine` (builds fine; not pinned) |
| luacheck | dev-only Lua lint (`.luarc.json`) | 1.2.0 (Lua 5.1) | ✅ installed |
| redis-cli | client for `lua/load.sh` | 7.0.15 | ✅ ok as client; local *server* must be 8.8+ (use Docker) |
| Docker / Compose | modern (`docker compose`, no v1 `docker-compose`) | 29.5.2 / v5.1.4 | ✅ |
| npm / git | bundled / any | 11.13.0 / 2.43.0 | ✅ |

No multi-version needs (single Java 21, single Node line; no `.nvmrc`/`.tool-versions`/Python/Go/PHP/TF).
Node parity (🟡): pin the repo (`engines`/`.nvmrc`) or bump the frontend Dockerfile build stage to
`node:24-alpine` to match the runtime VM.
- ✅ **`TokenBucketService` `XREADGROUP_UNDELIVERED_ENTRY`** (Jedis 7 API) — compile-verified via the
  Docker build; the service also now uses registered `FCALL acquire_token`/`release_token` instead of
  inline `EVAL`.

## Quality / cleanup (from `/code-review` of the working diff)

- 🟡 **Diagram-to-page mapping looks swapped.** `topic-routing.component.ts` (stream/Lua key routing)
  binds `diagrams.keyRouting`, while `pubsub-topic-routing.component.ts` binds `diagrams.topicRouting`.
  Both keys exist (so it compiles and the build passes), but the names suggest the two are crossed.
  → Verify each page shows its intended diagram.
- 🟡 **Hardcoded `http://localhost:8080` API base URLs** in `redis-api.service.ts`,
  `routing-rules.service.ts`, `websocket.service.ts`, and the `apiUrl` field of ~11 pattern
  components. Works only because ports are published to the host. → Centralize in one
  environment/config (Angular `environment.ts` or a runtime config) for portability.
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
- 🟠 **The same duplication risk is unaudited in the other claim-based patterns.** `TokenBucketService`
  documents the `minIdle` rule for `XAUTOCLAIM` but its numbers were never checked against its simulated
  work time, and neither was the LLM Chat recovery sweeper's. → Measure both the way the work queue was
  measured (count unique vs total entries in the output streams after a run).
- 🟡 **`@CrossOrigin(origins = "*")` on `WorkQueueController`** contradicts the `CorsConfig`
  allow-list documented in `CLAUDE.md`. Other pattern controllers may carry the same annotation.
  → Cross-cutting security decision, deliberately out of scope for that slice.
- 🟡 **`fanOut` diagram hard-codes 3 workers** in `diagram-definitions.service.ts` (the `workQueue`
  one was fixed in this slice, along with its wrong stream/group names). → Fix when the fan-out post
  is written.
- 🟡 **The input stream viewer empties itself while the stream still holds the entries** — surfaced by
  the manual pass on 2026-08-11 (`./launch-docker.sh --build`, burst of 200): the Job Stream panel
  showed `0 of 199 messages` plus a `... 189 more messages ...` spacer while `XLEN
  jobs.imageProcessing.v1` was 200. Cause: on success `WorkQueueService.processMessage` broadcasts a
  `MESSAGE_DELETED` event (pre-existing, commit `c21fcfe`) although the job is only `XACK`ed — never
  `XDEL`ed — so `stream-viewer` drops the row from `displayedMessages` while `totalMessages` keeps the
  real count. Cosmetic and **pre-existing**, but the burst makes it obvious. → Either stop lying in the
  event (rename to `MESSAGE_ACKED` and leave the row) or have the viewer decrement `totalMessages`.
  Deliberately not fixed with the dynamic-workers slice: `stream-viewer` is shared by all 12 patterns
  and that spec guards it as untouched.

## Code review & security

- ✅ **First full `/code-review`** (2026-06-29) — findings tracked in
  [`specs/code-review-findings.md`](specs/code-review-findings.md); P1/P2 fixes shipped in PR #2
  (Redis/pattern correctness, dedicated pub/sub connections, CORS allow-list, Lua loader hardening,
  inline `EVAL` → registered functions). Remaining follow-up: extract a typed decoder for `fcall`
  replies (readability of the critical paths).
- ✅ **First full `/security-review`** (2026-06-29) — no exploitable vuln beyond the by-design no-auth
  posture; the two concrete origin/sink gaps (WebSocket origin, Mermaid `innerHTML`) fixed in PR #3.

## Docs

- ✅ Addressed in this pass: `docs/` (PRD, architecture, 11 specs, 8 ADRs, migration-status),
  root `CLAUDE.md`, and README pattern list sync (see `/doc-sync`).
- 🟡 `augmentcode/CONTEXT.md` & `IMPLEMENTATION_REFERENCE.md` describe only the original 4 patterns
  and legacy stream names (`test-stream`). Kept for history; `docs/` supersedes them.
