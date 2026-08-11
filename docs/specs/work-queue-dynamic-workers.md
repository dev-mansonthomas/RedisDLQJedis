# Work Queue — dynamic worker count (slice A)

> Slice A of [`docs/product/brief-blog-workqueue-post.md`](../product/brief-blog-workqueue-post.md).
> Branch: `blog/work-queue-post`. Written for agents: implement exactly this.
> **Gate:** this spec *is* the author's validation for the demo-code changes listed under
> "Scope of change". Anything not listed here is report-only — do not touch it.
>
> **Delivered.** Kept as the record of slice A. Two decisions below were superseded on 2026-08-03 by the
> demo-mode presets (see the "Demo mode" section of [`work-queue.md`](work-queue.md)): the timing fields
> are no longer test-seams-only (a `PUT /demo-mode` drives them), and `minIdle` is no longer a fixed
> 100 ms — it moves with the mode, because 100/100 duplicated 45% of jobs in practice.

## Purpose

The `/work-queue` page runs a fixed pool of 4 worker Virtual Threads, so it cannot show the one
thing blog post #2 is about: **adding a consumer to a group makes the queue drain faster, and
removing one loses no job**. This slice makes the worker count adjustable at runtime (1–8) from the
page, makes the frontend read the stream names from the backend instead of hard-coding them, and
fixes the coherence drift the audit found (mermaid diagram, `docs/specs/work-queue.md`). No Lua
changes, no new Redis structure: `read_claim_or_dlq` is reused unchanged.

## Audit findings & disposition

Found while scoping; recorded here as the audit report required by the series brief.

| # | Finding | Disposition |
|---|---------|-------------|
| 1 | `docs/specs/work-queue.md` says group `mygroup`; code says `jobs-group` (`WorkQueueService.JOB_GROUP`). Its "Inferred — verify" item (worker count) is unresolved. | **Fixed in this slice** — code is the source of truth. |
| 2 | `frontend/.../work-queue.component.ts` never calls `GET /api/work-queue/streams`; all stream names are template literals (L83, L96-97, L110) and the group is the literal `'jobs-group'` (L84, L98, L111). The endpoint is dead code. | **Fixed in this slice** — the page consumes the endpoint. |
| 3 | `diagram-definitions.service.ts:13-60` (`workQueue`) is wrong on four axes: 3 workers (not 4), `jobs.workqueue.v1` (not `jobs.imageProcessing.v1`), `workerN.done` (not `jobs.done.worker-N`), `job-queue-group` (not `jobs-group`). | **Fixed in this slice.** |
| 4 | `WorkQueueController` carries `@CrossOrigin(origins = "*")`, which contradicts the `CorsConfig` allow-list documented in `CLAUDE.md`. Other controllers may do the same. | **Report only.** Out of scope: it is a cross-cutting security decision, not a work-queue one. Add to `docs/TODO.md`. |
| 5 | `fanOut` in the same diagram service has the identical 3-worker hard-coding. | **Report only** — fan-out is a later post's subject. Add to `docs/TODO.md`. |

## Scope of change (exhaustive)

Backend: `WorkQueueService`, `WorkQueueController`.
Frontend: `work-queue.component.ts`, `diagram-definitions.service.ts` (`workQueue` only).
Docs: `docs/specs/work-queue.md`, `docs/TODO.md`, `CLAUDE.md` (pattern table row if wording changes).
Tests: new `WorkQueueScalingIntegrationTest`, new `WorkQueueWorkersControllerTest`.

## User stories / acceptance criteria

- As a reader of the blog post, I can add a worker from the `/work-queue` page and see a new done
  stream panel start filling, so that I believe load is shared across consumers.
- As a reader, I can remove a worker and see that no job is lost.
- As a reader, I can **kill** a worker mid-job and watch another worker pick that job up, so that I
  understand at-least-once delivery and the PEL.
- As an agent implementing blog post #2, the stream/group names and worker bounds come from one
  place (the backend), so the post, the page and the code cannot drift.

Testable criteria — **all verified 2026-08-11** (`mvn clean test`: 93/93, 0 skipped, the
`redis:8.8-alpine` container really ran); the covering test is named on each line.

- [x] Given 4 workers at startup, when `POST /api/work-queue/workers` is called, then the response
      is `200` with `count = 5`, and `GET /api/work-queue/streams` lists 5 done streams
      (`jobs.done.worker-1` … `-5`) in order.
      → `startsWithFourWorkersAndExposesTheirStreams` + `boundsAreEnforced` (ordered ids up to `-8`),
      REST shape by `addWorkerReturnsTheNewWorker` + `streamsExposesDoneStreamsAsAnArray…`.
- [x] Given 8 workers, when `POST /api/work-queue/workers` is called, then the response is `409`,
      `success = false`, and the count stays 8. → `addWorkerAtTheCeilingIsAConflict` (409) +
      `boundsAreEnforced` (the count stays 8 after the throw).
- [x] Given 1 worker, when `DELETE /api/work-queue/workers` is called, then the response is `409`
      and the count stays 1. → `removeWorkerAtTheFloorIsAConflict` + `boundsAreEnforced`.
- [x] Given 5 workers and 20 `OK` jobs produced, when the queue drains, then the 20 `jobId` values
      appear across the 5 done streams **exactly once each**, and `XPENDING` on
      `jobs.imageProcessing.v1` for `jobs-group` is 0. → `everyJobIsProcessedExactlyOnceAcrossWorkers`.
- [x] Given a worker holding a job in flight, when `DELETE /api/work-queue/workers?kill=false` is
      called, then that job still completes (present in its done stream, `XPENDING` = 0) and
      the worker thread has exited. → `gracefulRemoveFinishesTheInFlightJob`.
      **Amended**: the test grows the pool to 2 and removes `worker-2`, because `MIN_WORKERS = 1`
      forbids removing the *last* worker — the original "given 1 worker" wording was unreachable.
- [x] Given a worker holding a job in flight, when `DELETE /api/work-queue/workers?kill=true` is
      called, then the job is **not** ACKed: `XPENDING` = 1 with `deliveryCount = 1`, no entry in
      any done stream, and `XINFO CONSUMERS jobs.imageProcessing.v1 jobs-group` **still lists**
      that consumer (proof that no `XGROUP DELCONSUMER` was issued).
      → `killedWorkerLeavesTheJobPendingAndKeepsTheConsumer` (same 2-worker amendment).
      Run 5× in isolation on 2026-08-11 without a flake (the interrupt was the plan's riskiest step).
- [x] Continuing from the previous state, when a worker is added, then within 5 s the job is claimed
      and completed (present in exactly one done stream, `XPENDING` = 0).
      → `theKilledWorkersJobIsRecoveredByAnotherWorker`.
- [x] **Revised 2026-07-31 (was: "a job killed twice reaches the DLQ").** That scenario is not
      deterministically reachable: `MIN_WORKERS = 1` forbids killing the last holder, so a free worker
      always ends up reclaiming and completing the job. Covered instead by composition — a kill costs
      one delivery (`killedWorkerLeavesTheJobPendingAndKeepsTheConsumer` asserts
      `deliveryCount == 1`) and budget exhaustion routes to the DLQ
      (`aFailingJobIsRoutedToTheDlqAfterItsRetryBudget`, using the demo's own `Error` path).
- [x] Given 2 workers, when `DELETE /api/work-queue/clear` is called, then done streams
      `jobs.done.worker-1` … `-8` are all deleted (no orphan from a previously higher count) and
      `XINFO GROUPS jobs.imageProcessing.v1` shows `jobs-group` recreated.
      → `clearDeletesDoneStreamsBeyondTheCurrentWorkerCount`.
- [x] `grep -n "1,2,3,4" frontend/src/app/components/work-queue/work-queue.component.ts` → no hits,
      and every `[stream]`/`[group]` binding reads from the `/streams` payload
      (`rg '\[stream\]=|\[group\]=' …` shows only `streams.*` / the loop variable).
      **Revised 2026-07-31**: the original wording forbade those names *anywhere* in the file, which
      would also strip the "How it works" prose that teaches the reader the real key names. Only
      functional duplication is banned; documentation text may name the keys.
- [x] `grep -n "jobs.workqueue.v1\|job-queue-group\|worker1.done" frontend/src/app/services/diagram-definitions.service.ts`
      → no hits.
- [x] `mvn clean test` green (all pre-existing tests + the new ones); `cd frontend && npm run lint`
      shows **no new** errors versus the pre-change baseline (record the baseline count first —
      ~78 pre-existing per `CLAUDE.md`); `cd frontend && npm run build` succeeds.
      → 2026-08-11: `mvn clean test` **93/93, 0 skipped**; lint **72 errors** (below the ~76-78
      baseline, so no new ones); `luacheck` 0 errors / 1 cosmetic warning, proving no Lua was touched.
      `npm run build` is **green as of the last run before this branch's final docs pass** — see the
      caveat below.

> **Build-gate caveat (2026-08-11).** `npm run build` could not be re-run to completion in the VM
> that day: with an unrelated Redis Enterprise container (`rec1`, 1.5 GiB) up, only ~1.5 GB of the
> 7.9 GB was free, the build process climbed to ~1.1 GB and the kernel OOM-killed it (`Killed`, no
> Angular error). Reproduced 3× including with `NG_BUILD_MAX_WORKERS=1` and
> `--max-old-space-size=1100`, and measured (`avail` fell to 26 MB). This is an environment limit,
> not a code defect. Substituted two memory-light gates that cover the compile step the build would
> have exercised, both **exit 0**: `npx tsc -p tsconfig.app.json --noEmit` (TypeScript) and
> `npx ngc -p tsconfig.app.json --noEmit` (**Angular AOT — type-checks the templates too**, which
> lint does not). What stays unverified is only bundling/optimization.
> **Re-run `npm run build` before merge** once the RAM is free (`docker stop rec1`, build,
> `docker start rec1`).

## Inputs & outputs

### Redis keys & names (unchanged)

| Thing | Value |
|---|---|
| Job stream | `jobs.imageProcessing.v1` |
| Consumer group | `jobs-group` |
| DLQ | `jobs.imageProcessing.v1:dlq` |
| Done stream (per worker) | `jobs.done.worker-{id}`, `id` ∈ 1..count |
| Consumer name | `worker-{id}` (identical to today) |
| Lua | `FCALL read_claim_or_dlq 2 <stream> <dlq> jobs-group worker-{id} 100 1 2` (unchanged) |

### Worker pool invariants

- `MIN_WORKERS = 1`, `MAX_WORKERS = 8`, `INITIAL_WORKERS = 4` — `static final` constants in
  `WorkQueueService`. **Not** persisted, **not** in `application.yml`: the pool resets to 4 on
  restart (decided 2026-07-31 — no new config surface).
- Worker ids are always **contiguous** `1..count`. Add → id `count + 1`. Remove → always the
  **highest** id. This keeps done-stream names and UI panels contiguous and removes the need for an
  id parameter on the REST calls.

### `WorkQueueService` API (new/changed)

```java
// state: replaces `Map<Integer, AtomicBoolean> workerRunning`
private record WorkerHandle(Thread thread, AtomicBoolean running) {}
private final Map<Integer, WorkerHandle> workers = new ConcurrentHashMap<>();  // id -> handle

public synchronized int addWorker();            // throws IllegalStateException at MAX_WORKERS
public synchronized int removeWorker(boolean kill); // throws IllegalStateException at MIN_WORKERS
public int workerCount();                       // workers.size()
public Map<String, Object> getWorkerState();    // {count, min, max}
public Map<String, Object> getStreamNames();    // shape below (CHANGED)
```

`getStreamNames()` new shape (the old flat `doneStream1..N` keys are **removed**; the frontend was
the only would-be consumer and never called it):

```json
{
  "jobStream": "jobs.imageProcessing.v1",
  "dlqStream": "jobs.imageProcessing.v1:dlq",
  "group": "jobs-group",
  "doneStreams": ["jobs.done.worker-1", "jobs.done.worker-2", "jobs.done.worker-3", "jobs.done.worker-4"]
}
```

Test seam (required for deterministic tests, see Test plan): `PROCESSING_SLEEP_MS` and
`POLL_INTERVAL_MS` become **package-private non-final** fields (`long processingSleepMs = 100;`
`long pollIntervalMs = 100;`) instead of `private static final`. No setter, no config property —
tests in the same package assign them directly. Document the intent in a comment.

### REST endpoints

`GET /api/work-queue/streams` — **changed payload**:

```json
{ "success": true,
  "streams": { "jobStream": "...", "dlqStream": "...", "group": "jobs-group",
               "doneStreams": ["jobs.done.worker-1", "..."] },
  "workers": { "count": 4, "min": 1, "max": 8 } }
```

`GET /api/work-queue/workers` → `200`

```json
{ "success": true, "count": 4, "min": 1, "max": 8,
  "consumers": [ { "id": 1, "name": "worker-1", "doneStream": "jobs.done.worker-1" }, "..." ] }
```

`POST /api/work-queue/workers` → `200` on success, `409` at the ceiling

```json
{ "success": true, "count": 5, "added": { "id": 5, "name": "worker-5", "doneStream": "jobs.done.worker-5" } }
{ "success": false, "error": "Worker count is already at the maximum (8)", "count": 8 }
```

`DELETE /api/work-queue/workers?kill=false` → `200` on success, `409` at the floor

- `kill=false` (default) — **graceful**: the worker finishes its in-flight job (XADD to its done
  stream + XACK) and then exits.
- `kill=true` — **abrupt**: the worker thread is interrupted; an in-flight job is left un-ACKed in
  the PEL. This is the demo that feeds the post's crash-recovery section.

```json
{ "success": true, "count": 4, "kill": true,
  "removed": { "id": 5, "name": "worker-5", "doneStream": "jobs.done.worker-5" },
  "note": "Consumer worker-5 kept in the group (no XGROUP DELCONSUMER) so its pending entries stay claimable" }
```

Error style follows the existing controller: `Map<String, Object>` body, `success` flag,
`ResponseEntity.status(HttpStatus.CONFLICT)` for bound violations, `internalServerError()` for
unexpected exceptions.

### Frontend contract

- On init: `GET /api/work-queue/streams` → store `streams` and `workers` in plain fields (this
  component uses `ChangeDetectionStrategy.OnPush` with explicit `cdr.markForCheck()` and **no
  signals** — match that idiom, do not introduce signals).
- Worker panels: `*ngFor="let s of streams.doneStreams; trackBy: trackByStream"` with
  `trackByStream = (_: number, s: string) => s` so existing `app-stream-viewer` instances survive a
  count change (today's `*ngFor="let w of [1,2,3,4]"` has no `trackBy`).
- Input stream / DLQ / group bindings use `streams.jobStream`, `streams.dlqStream`, `streams.group`.
- Two new buttons in the existing `.btn` idiom (no Angular Material — the repo uses none):
  `+ Add worker` (disabled when `workers.count >= workers.max`) and `− Remove worker` (disabled when
  `workers.count <= workers.min`), plus a `💀 Kill worker` button calling `?kill=true`, and a
  `Workers: {{workers.count}} / {{workers.max}}` counter in the `.job-counter` style.
- After every worker mutation: re-`GET /streams`, then `refreshService.triggerRefresh()` (the
  refresh service is a global `Subject<void>` — no per-stream registration exists or is needed).
- CSS: `.stream-row.workers { grid-template-columns: repeat(4, 1fr); }` →
  `repeat(auto-fit, minmax(220px, 1fr))`; keep the existing responsive overrides below it.
- Prose to correct (currently claims a fixed 4): class doc comment L20, description L33-36,
  `👷 Worker Processing (4 Virtual Threads)` L142, `4 workers start` L144,
  `jobs.done.worker-1..4` L166-168 → phrase in terms of `N` / "one Virtual Thread per worker".

### Mermaid diagram (`diagram-definitions.service.ts`, `workQueue` only)

Stays a static template string (do not generate it from the live count — the diagram must remain
valid at any `N`). Required corrections: `jobs.imageProcessing.v1`, `jobs.imageProcessing.v1:dlq`,
`jobs-group`, done streams `jobs.done.worker-1` / `-2` / `-N`, and worker nodes labelled
`Worker 1`, `Worker 2`, `… ⋯`, `Worker N` (3 boxes + an ellipsis node) instead of a hard 3. The
sequence diagram keeps 2 workers but must use the corrected names.

## Behavior & edge cases

**Happy path.** `addWorker()` → next id, `streamListenerService.startMonitoring(doneStream)` (already
idempotent — it returns early when the stream is in `activeMonitors`), start a Virtual Thread named
`work-queue-worker-{id}`, register the handle, return the new count. The new consumer joins
`jobs-group` implicitly on its first `XREADGROUP`/`FCALL` — **no `XGROUP CREATECONSUMER` needed**.

Edge cases:

- **At the bounds** — `addWorker()` at 8 and `removeWorker()` at 1 throw `IllegalStateException`;
  the controller maps it to `409`. State is unchanged.
- **Concurrent add/remove** — both methods are `synchronized` on the service instance; `workers.size()`
  is the single source of truth for the count, so ids stay contiguous under concurrent calls.
- **Graceful remove (`kill=false`)** — set `running = false`; the loop exits at its next top-of-loop
  check, after the in-flight job has been ACKed. `join(2000)` before returning so the caller
  observes a stopped worker; if the join times out, log a warning and still return success (the flag
  guarantees eventual exit).
- **Abrupt remove (`kill=true`)** — set `running = false` **then** `thread.interrupt()`, then
  `join(1000)`. The interrupt lands either in `Thread.sleep(processingSleepMs)` inside
  `processMessage` (the existing `catch (InterruptedException)` already returns **without** XADD/XACK
  — exactly the desired "job left pending") or in the poll sleep (nothing in flight, no effect on
  Redis). If it lands during a Redis call, virtual-thread socket I/O is interruptible: the call may
  throw `JedisConnectionException`, the try-with-resources discards that pooled connection, and the
  loop exits because `running` is false. Log at WARN, never rethrow.
- **Removed consumers are never deleted from the group.** No `XGROUP DELCONSUMER`, ever:
  `DELCONSUMER` drops that consumer's PEL entries, which would **lose** the in-flight job. The
  killed consumer's entries stay claimable by `read_claim_or_dlq` after `minIdle = 100 ms`. This is
  the pattern's teaching point; assert it in tests and state it in the API `note` field.
- **Killed twice = DLQ.** Each kill increments the delivery counter. With `maxDeliver = 2`, killing
  the owner of the same job twice makes the next poll route it to
  `jobs.imageProcessing.v1:dlq`. Correct behavior, must be documented in the page's info text so a
  reader who kills repeatedly is not surprised.
- **Done streams of removed workers are not deleted** — their data stays in Redis and reappears when
  the count grows back. Panels show ids `1..count` only, so a removed worker's history is hidden,
  not lost. Only `DELETE /clear` deletes, and it deletes `1..MAX_WORKERS` (not `1..count`) so no
  orphan survives a shrink.
- **Monitoring is not stopped on removal** — leaving the `StreamMonitor` alive keeps re-add a no-op
  and avoids a stop/start race on `XREAD BLOCK`. The cost is one parked Virtual Thread per removed
  worker (≤ 8 total). Do **not** call `stopMonitoring`.
- **`stopWorkers()` (shutdown)** keeps working over the new map: iterate handles, set `running=false`.
- **Empty pool is unreachable** — `MIN_WORKERS = 1` means the queue always has a consumer, so a
  reader never lands on a page that silently stops processing.

## Out of scope

- Any change to `lua/stream_utils.lua`, to `read_claim_or_dlq`, or to `maxDeliver`/`minIdle`/`count`
  values.
- The blog post itself (slice B) and its samples; the French version (slice C).
- Persisting the worker count, or exposing it in `application.yml`.
- Per-worker id targeting on remove (`DELETE /workers/{id}`), pausing a worker, or per-worker
  throughput metrics.
- `@CrossOrigin(origins = "*")` (finding #4) and the `fanOut` diagram (finding #5) — report only.
- Frontend unit tests: the project has **no** Angular test runner configured (`ng test` has no
  builder — `docs/TODO.md`). Frontend verification for this slice is `npm run lint` + `npm run build`
  + a manual pass on `/work-queue` via `./launch-docker.sh --build`.

## Test plan

Backend, `mvn clean test` (incremental compilation is unreliable in this VM — always `clean`).

**`WorkQueueScalingIntegrationTest extends AbstractRedisIntegrationTest`** (real `redis:8.8-alpine`
via the docker CLI; skips when Docker is absent). Build the service like
`DLQXnackIntegrationTest` does: `new WorkQueueService(jedisPool, new WebSocketEventService(new
ObjectMapper()), new RedisStreamListenerService(jedisPool, webSocketEventService))`, then
`jedis.functionLoadReplace(Files.readString(Path.of("lua/stream_utils.lua")))` and
`service.run()`. Set `service.processingSleepMs = 2000` in tests that need a wide in-flight window
(this is why the field stops being `static final`) and `service.pollIntervalMs = 20` for fast drain
tests. Add a local `awaitUntil(Duration, BooleanSupplier)` polling helper (5 ms granularity); no new
test dependency.

1. `boundsAreEnforced` — from 4: 4 × add → 8, 5th add throws / count stays 8; 7 × remove → 1, 8th
   remove throws / count stays 1.
2. `addedWorkerGetsContiguousIdAndStream` — add → `getStreamNames().doneStreams` has 5 ordered
   entries ending in `jobs.done.worker-5`; `getWorkerState()` = `{count:5,min:1,max:8}`.
3. `everyJobIsProcessedExactlyOnceAcrossWorkers` — 5 workers, `pollIntervalMs=20`, produce 20 `OK`
   jobs → await until the union of the 5 done streams has 20 entries; assert the 20 `jobId`s are
   distinct and equal the produced set; assert `XPENDING` count = 0.
4. `gracefulRemoveFinishesTheInFlightJob` — shrink to 1 worker, `processingSleepMs = 2000`, produce
   1 `OK` job, await `XPENDING` = 1 owned by `worker-1`, then `removeWorker(false)` → await the job
   in `jobs.done.worker-1` and `XPENDING` = 0.
5. `killedWorkerLeavesTheJobPendingAndKeepsTheConsumer` — same setup, `removeWorker(true)` → assert
   no entry in any done stream, `XPENDING` = 1 with `deliveryCount = 1`, and
   `XINFO CONSUMERS jobs.imageProcessing.v1 jobs-group` still contains `worker-1`.
6. `anotherWorkerRecoversTheKilledJob` — continue from 5: `processingSleepMs = 50`,
   `addWorker()` → await (≤ 5 s) the job in a done stream and `XPENDING` = 0.
7. `twoKillsRouteTheJobToTheDlq` — kill the owner twice (deliveries → 2) then let a worker poll →
   await 1 entry in `jobs.imageProcessing.v1:dlq` and `XPENDING` = 0.
8. `clearDeletesDoneStreamsBeyondTheCurrentCount` — grow to 6, produce/drain a few jobs, shrink to
   2, `clearAllStreams()` → `EXISTS` is 0 for `jobs.done.worker-1..8`, job stream and DLQ empty,
   `XINFO GROUPS` shows `jobs-group`.

**`WorkQueueWorkersControllerTest`** — `@WebMvcTest(WorkQueueController.class)` +
`@MockitoBean WorkQueueService` (mirrors `DLQProcessControllerTest`):

9. `GET /work-queue/workers` → 200, JSON `count/min/max/consumers[0].name`.
10. `POST /work-queue/workers` → 200 with `added.id`; when the service throws
    `IllegalStateException` → **409** with `success:false`.
11. `DELETE /work-queue/workers` with no param → `verify(service).removeWorker(false)`;
    `?kill=true` → `verify(service).removeWorker(true)`; at the floor → **409**.
12. `GET /work-queue/streams` → 200 with `streams.doneStreams` as a JSON **array** and
    `workers.count` present (locks the new payload shape).

**Non-Java gates:** `cd frontend && npm run lint` (no new errors vs. the recorded baseline),
`npm run build` (must succeed), `luacheck lua/ --globals redis cjson cmsgpack bit` (unchanged, 0
errors — proves no Lua was touched), plus a manual `./launch-docker.sh --build` pass: add a worker →
a 5th panel appears and fills; kill a worker mid-job → the job reappears in another worker's done
stream.

## Dependencies & risks

- **No new library.** Jedis 7.5.3, Spring Boot 3.5.7, Angular 21 as pinned (`pom.xml`,
  `frontend/package.json`). Nothing to check via Context7 for this slice — verify versions only if a
  dependency is added, which this spec forbids.
- **Riskiest #1 — the interrupt path.** Interrupting a Virtual Thread blocked in a Jedis socket call
  can surface as `JedisConnectionException` and poison a pooled connection. Mitigation: `running`
  is cleared **before** the interrupt, all exceptions in the worker loop are caught and logged, and
  the connection is always obtained via try-with-resources. Test 5 must be run repeatedly
  (`mvn test -Dtest=WorkQueueScalingIntegrationTest -DfailIfNoTests=false`, ≥ 5 runs) to confirm it
  is not flaky.
- **Riskiest #2 — test timing.** The in-flight window is what makes tests 4-7 deterministic; it only
  exists because `processingSleepMs` is assignable. If that seam is rejected, these tests become
  inherently flaky — do not replace them with `Thread.sleep` guesses.
- **Riskiest #3 — payload break.** `GET /streams` changes shape. Verified that only
  `work-queue.component.ts` could consume it and today it does not (`grep` for the endpoint returns
  the controller only). Re-run that grep before merging.
- **Coupling to slice B.** The post claims page/code/doc coherence, so finding #3 (diagram) must
  land here; if it slips, slice B's coherence acceptance box fails.

## Next step

Run `/plan-feature work-queue-dynamic-workers` to break this into TDD-ordered steps (audit doc fixes
→ service state + bounds → REST → interrupt/graceful semantics + tests → frontend wiring → diagram →
verification).
