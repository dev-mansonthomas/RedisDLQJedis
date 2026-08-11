# Plan — work-queue-dynamic-workers (test-first)

> Spec: `docs/specs/work-queue-dynamic-workers.md`. Brief: `docs/product/brief-blog-workqueue-post.md`.
> Branch: `blog/work-queue-post`. Slice A of blog post #2 — the post itself is slice B.

## Dependencies — nothing new (Context7 not applicable)

The spec **forbids** adding dependencies, so there is no version/API to verify: Jedis **7.5.3**,
Spring Boot **3.5.7**, Angular **21** as already pinned in `pom.xml` / `frontend/package.json`.

Two consequences that shape the tests:

- **No Awaitility** (it would be a new Maven dependency) → each integration test uses a local
  `awaitUntil(Duration, BooleanSupplier)` helper polling every 5 ms.
- **No new Jedis API surface.** `XINFO CONSUMERS` is needed by test 5; Jedis 7.5.3 exposes
  `jedis.xinfoConsumers(stream, group)` → `List<StreamConsumerInfo>` with `getName()`. **Confirm
  this signature against the jar at task 5** (`javap -cp $(ls ~/.m2/repository/redis/clients/jedis/7.5.3/jedis-7.5.3.jar) redis.clients.jedis.Jedis | grep -i xinfoconsumer`);
  if it differs, fall back to `jedis.sendCommand(Protocol.Command.XINFO, "CONSUMERS", …)` like
  `DLQXnackIntegrationTest` does for `XNACK` — do **not** add a library.

## Ground truth from the existing code (do not re-derive)

- `WorkQueueService.processMessage(...)` **already** catches `InterruptedException` around
  `Thread.sleep(PROCESSING_SLEEP_MS)` and `return`s **without** `XADD`-done and **without** `XACK`.
  The whole `kill=true` behavior therefore falls out of an `interrupt()` — no new branch in the
  processing path.
- `RedisStreamListenerService.startMonitoring(name)` returns early when the stream is already in
  `activeMonitors` → **idempotent**, safe to call on every `addWorker()`. Reuse it; do not guard it
  again in `WorkQueueService`.
- `startWorker(int)` already exists and creates the Virtual Thread named `work-queue-worker-{id}`.
  `addWorker()` must **reuse** it (extended to return the `Thread`), not duplicate it.
- `RedisStreamSupport.ensureGroup(...)` (used by `initializeConsumerGroup`) tolerates `BUSYGROUP` —
  reuse for the group recreation in `clearAllStreams()`; nothing to write.
- `StreamRefreshService` is a bare `Subject<void>` with no per-stream keying → a new worker panel
  needs **zero** registration on the frontend. `triggerRefresh()` is enough.
- A new consumer joins `jobs-group` implicitly on its first read. **No `XGROUP CREATECONSUMER`.**

## Test-harness gotcha (must be in place before any test is written)

`AbstractRedisIntegrationTest.flushRedis()` runs `flushAll` in `@BeforeEach` (superclass first), so
the per-test `WorkQueueService` must be built **after** the flush — fine — but it must also be torn
down: without `@AfterEach service.stopWorkers()`, the previous test's 4+ worker threads keep polling
the shared container and steal the next test's jobs. Every subsequent task depends on this.

## Ordered tasks

### T0 — Baseline capture (no code change, blocking)

Record, before touching anything, so later "no new errors" claims are provable:

```bash
mvn clean test 2>&1 | tail -25                      # expect BUILD SUCCESS, 55 tests
cd frontend && npm run lint 2>&1 | tail -5          # record the exact error count (~78 expected)
luacheck lua/ --globals redis cjson cmsgpack bit    # expect 0 errors, 5 warnings
grep -rn "work-queue/streams" frontend/src src      # expect: controller only, no frontend caller
```

Paste the four results into the PR description. **Done when** all four are recorded; if `mvn clean
test` is already red, stop and report — do not build on a broken baseline.

### T1 — Worker state as a map of handles (red → green)

**RED** — create `src/test/java/com/redis/patterns/service/WorkQueueScalingIntegrationTest.java`
extending `AbstractRedisIntegrationTest`, with the `@BeforeEach` (build service like
`DLQXnackIntegrationTest`: `new WebSocketEventService(new ObjectMapper())`, `new
RedisStreamListenerService(jedisPool, wsService)`, `functionLoadReplace(Files.readString(Path.of("lua/stream_utils.lua")))`,
`service.run()`), the `@AfterEach service.stopWorkers()`, and the `awaitUntil` helper. First test
`startsWithFourWorkersAndExposesTheirStreams`: asserts `service.workerCount() == 4`,
`getWorkerState()` equals `{count:4,min:1,max:8}`, and `getStreamNames().get("doneStreams")` is a
`List` of the 4 ordered names plus keys `jobStream`/`dlqStream`/`group`.
→ **Fails to compile** (`workerCount`, `getWorkerState` don't exist; `doneStreams` absent).

**GREEN** — `src/main/java/com/redis/patterns/service/WorkQueueService.java`: add
`private record WorkerHandle(Thread thread, AtomicBoolean running) {}`, replace
`Map<Integer, AtomicBoolean> workerRunning` with `Map<Integer, WorkerHandle> workers`, add
`MIN_WORKERS=1` / `MAX_WORKERS=8` / `INITIAL_WORKERS=4` constants (delete `NUM_WORKERS`), add
`workerCount()` / `getWorkerState()`, rewrite `getStreamNames()` to the new shape, make
`startWorker(int)` return the `Thread`, and switch `run()` / `stopWorkers()` / `clearAllStreams()` to
the new map. Also change `PROCESSING_SLEEP_MS`/`POLL_INTERVAL_MS` to package-private non-final
`processingSleepMs`/`pollIntervalMs` (comment: test seam, not config).

**REFACTOR** — none expected; keep the javadoc header's feature list accurate (it says "4 worker
Virtual Threads" → "1–8 worker Virtual Threads, 4 at startup").

### T2 — Bounds enforcement (red → green)

**RED** — same test class, `boundsAreEnforced`: from 4, four `addWorker()` → 8 and a fifth throws
`IllegalStateException` with count still 8; then seven `removeWorker(false)` → 1 and an eighth throws
with count still 1. Ids observed via `getStreamNames()` stay contiguous `1..count`.

**GREEN** — `addWorker()` / `removeWorker(boolean)` in `WorkQueueService`, both `synchronized`:
guard against `MAX_WORKERS`/`MIN_WORKERS`, allocate `count+1` / drop the highest id, call
`streamListenerService.startMonitoring(JOB_DONE_PREFIX + id)` then `startWorker(id)` on add. For
this task `removeWorker` may simply clear the flag and `join` — the kill semantics land in T5.

### T3 — Load really is shared (regression lock, expected green on first run)

**Honest label**: after T2 this should pass immediately — it locks behavior rather than driving it.
Write it anyway; if it fails, T2's `addWorker` isn't starting a working consumer.

`everyJobIsProcessedExactlyOnceAcrossWorkers`: set `pollIntervalMs = 20`, `processingSleepMs = 5`,
`addWorker()` → 5 workers, produce 20 `OK` jobs via `service.produceJob(...)`, `awaitUntil` the union
of `jobs.done.worker-1..5` holds 20 entries (≤ 10 s), then assert the 20 `jobId` values are
**distinct** and equal the produced set, and `XPENDING` on `jobs.imageProcessing.v1`/`jobs-group`
is 0. Reuse `jedis.xrange(...)` for reading done streams and `jedis.xpending(stream, group)` for the
summary.

### T4 — Graceful removal finishes the in-flight job (red → green)

**RED** — `gracefulRemoveFinishesTheInFlightJob`: shrink to 1 worker, `processingSleepMs = 2000`,
produce one `OK` job, `awaitUntil` `XPENDING` shows 1 entry owned by `worker-1`, call
`removeWorker(false)`, then assert the job **is** in `jobs.done.worker-1` and `XPENDING` = 0, and
`service.workerCount() == 0`… **no** — `MIN_WORKERS = 1` forbids removing the last worker, so the
test must grow to 2 workers first, park a job on `worker-2`, and remove `worker-2`. Write it that
way (and note it in the test's javadoc: the floor means the *last* worker can never be removed).

**GREEN** — `removeWorker(false)`: `running.set(false)`, `thread.join(2000)`, log a WARN if the join
times out, remove the map entry, return the new count. Do **not** `stopMonitoring`, do **not**
`XGROUP DELCONSUMER`.

### T5 — Kill leaves the job pending and keeps the consumer (red → green) ⚠ riskiest

**RED** — `killedWorkerLeavesTheJobPendingAndKeepsTheConsumer`: same 2-worker setup with
`processingSleepMs = 2000`; once `worker-2` owns the entry, `removeWorker(true)` → assert (a) no
entry in any `jobs.done.worker-*`, (b) `XPENDING` = 1 with `deliveryCount == 1`, (c)
`xinfoConsumers("jobs.imageProcessing.v1", "jobs-group")` still contains `worker-2`.

**GREEN** — `removeWorker(true)`: `running.set(false)` **then** `thread.interrupt()`, `join(1000)`,
drop the entry. Catch and WARN on any exception; never rethrow.

**REFACTOR** — in `workerLoop`, make sure a `JedisConnectionException` raised by an interrupted
socket call is logged at WARN (not ERROR) when `!running.get()`, so a normal kill doesn't look like
a failure in the logs.

### T6 — Another worker recovers the killed job (regression lock)

`anotherWorkerRecoversTheKilledJob`: continuing from T5's state, set `processingSleepMs = 50`,
`addWorker()`, `awaitUntil` (≤ 5 s) the job appears in exactly one done stream and `XPENDING` = 0.
This is the assertion the blog post's crash-recovery section rests on — it must exist even though
`read_claim_or_dlq` already provides the behavior.

### T7 — Two kills route the job to the DLQ (regression lock)

`twoKillsRouteTheJobToTheDlq`: kill the owner twice (deliveries → 2), then let a worker poll →
`awaitUntil` 1 entry in `jobs.imageProcessing.v1:dlq` and `XPENDING` = 0. Documents the interaction
with `maxDeliver = 2` that the page's info text must warn about.

### T8 — `clear` deletes done streams beyond the current count (red → green)

**RED** — `clearDeletesDoneStreamsBeyondTheCurrentCount`: grow to 6, drain a few jobs so
`jobs.done.worker-5`/`-6` exist, shrink to 2, `clearAllStreams()` → assert `jedis.exists(...)` is
false for `jobs.done.worker-1..8`, `XLEN` 0 on job stream and DLQ, and `XINFO GROUPS` lists
`jobs-group`.

**GREEN** — `clearAllStreams()`: loop `1..MAX_WORKERS` instead of the current count.

### T9 — REST contract (red → green)

**RED** — create `src/test/java/com/redis/patterns/controller/WorkQueueWorkersControllerTest.java`,
`@WebMvcTest(WorkQueueController.class)` + `@MockitoBean WorkQueueService` (mirror
`DLQProcessControllerTest`): `GET /work-queue/workers` → 200 + `count/min/max/consumers[0].name`;
`POST /work-queue/workers` → 200 + `added.id`, and **409** + `success:false` when the service throws
`IllegalStateException`; `DELETE /work-queue/workers` → `verify(service).removeWorker(false)`,
`?kill=true` → `verify(service).removeWorker(true)`, floor → **409**; `GET /work-queue/streams` →
`streams.doneStreams` is a JSON **array** and `workers.count` is present.

**GREEN** — `src/main/java/com/redis/patterns/controller/WorkQueueController.java`: add the three
`/workers` handlers and extend `/streams` with the `workers` block, following the existing
`Map<String,Object>` + `success` style; map `IllegalStateException` →
`ResponseEntity.status(HttpStatus.CONFLICT)`.

### T10 — Frontend wiring (no unit test available — lint + build + manual)

`frontend/src/app/components/work-queue/work-queue.component.ts`, in this order:

1. Fields + `loadStreams()` calling `GET {apiUrl}/streams`, storing `streams` and `workers`; call it
   from `ngOnInit`; `cdr.markForCheck()` on response (plain fields + OnPush — **no signals**, match
   the file's idiom).
2. Replace `*ngFor="let w of [1,2,3,4]"` (L96) with `*ngFor="let s of streams.doneStreams; trackBy: trackByStream"`
   and bind `[stream]="s"`; bind the input viewer (L83) and DLQ viewer (L110) to `streams.jobStream` /
   `streams.dlqStream`, and all three `[group]` bindings to `streams.group`. Guard the whole block
   with `*ngIf="streams"`.
3. `addWorker()` / `removeWorker(kill: boolean)` → `POST` / `DELETE …?kill=` then `loadStreams()` +
   `refreshService.triggerRefresh()`; on 409, surface the message in the existing counter area rather
   than failing silently.
4. Buttons in the existing `.btn` idiom (L56-61 is the template): `+ Add worker`
   (`[disabled]="workers.count >= workers.max"`), `− Remove worker`
   (`[disabled]="workers.count <= workers.min"`), `💀 Kill worker` (same disable rule), and a
   `Workers: {{workers.count}} / {{workers.max}}` readout styled like `.job-counter` (L281-287).
5. CSS L309: `repeat(4, 1fr)` → `repeat(auto-fit, minmax(220px, 1fr))`; keep the L313/L320
   responsive overrides.
6. Prose: L20 doc comment, L33-36 description, L142 `(4 Virtual Threads)`, L144 `4 workers start`,
   L166-168 `jobs.done.worker-1..4` → phrase in terms of `N`; add one line to the info text warning
   that killing the same job twice sends it to the DLQ (`maxDeliver = 2`).

### T11 — Mermaid diagram (audit finding #3)

`frontend/src/app/services/diagram-definitions.service.ts`, `workQueue` only (leave `fanOut` alone —
report-only finding #5): fix `jobs.imageProcessing.v1`, `jobs.imageProcessing.v1:dlq`, `jobs-group`,
`jobs.done.worker-1`/`-2`/`-N`, and replace the hard 3 worker nodes with `Worker 1`, `Worker 2`, an
ellipsis node, `Worker N`. Fix the sequence diagram's names too (2 workers is fine). Keep it a
static string — do **not** generate it from the live count.

Proof: `grep -n "jobs.workqueue.v1\|job-queue-group\|worker1.done" frontend/src/app/services/diagram-definitions.service.ts`
→ no hits.

### T12 — Docs (audit findings #1, #4, #5)

- Rewrite `docs/specs/work-queue.md` from the code: `jobs-group`, worker pool 1–8 (4 at startup, not
  persisted), the three `/workers` endpoints, the new `/streams` payload, `count=1`,
  `maxDeliver=2`, `minIdle=100ms`, graceful-vs-kill semantics, and the no-`DELCONSUMER` rule.
  **Delete** its "Inferred — verify" section.
- `docs/TODO.md`: add finding #4 (`@CrossOrigin(origins="*")` on `WorkQueueController` contradicts
  the `CorsConfig` allow-list) and finding #5 (`fanOut` diagram hard-codes 3 workers).
- `CLAUDE.md`: update the `/work-queue` row of the pattern table (worker count now 1–8, adjustable at
  runtime; kill-worker demo) and the `mvn test` count in "How to run".

### T13 — Full verification gate

```bash
mvn clean test                                              # all pre-existing + new tests green
for i in 1 2 3 4 5; do mvn clean test -Dtest=WorkQueueScalingIntegrationTest || break; done
luacheck lua/ --globals redis cjson cmsgpack bit            # unchanged: 0 errors (no Lua touched)
cd frontend && npm run lint                                 # error count ≤ T0 baseline
cd frontend && npm run build                                # must succeed
grep -n "1,2,3,4" frontend/src/app/components/work-queue/work-queue.component.ts          # no hits
grep -nE '\[stream\]=|\[group\]=' \
  frontend/src/app/components/work-queue/work-queue.component.ts   # only streams.* / the loop var
./launch-docker.sh --build                                  # manual pass on /work-queue
```

**Corrected 2026-08-11** — the second grep used to be `grep -n "jobs.imageProcessing.v1\|jobs-group\|
jobs.done.worker-" … # no hits`, which contradicts the spec's own revised criterion: those names
legitimately appear in the page's "How it works" prose (5 hits, l. 313-349), which is what teaches the
reader the real key names. Only **functional** duplication is banned, so the gate checks the bindings
instead. Do not "fix" those prose hits.

Manual pass, on http://localhost:4200/work-queue: start producing → add a worker → a 5th panel
appears and fills; kill a worker mid-job → the job reappears in another worker's done stream; clear
→ all panels empty; the mermaid diagram shows the real stream names.

## Files: create vs modify

**Create (4)**
- `src/test/java/com/redis/patterns/service/WorkQueueScalingIntegrationTest.java`
- `src/test/java/com/redis/patterns/controller/WorkQueueWorkersControllerTest.java`
- `docs/specs/work-queue-dynamic-workers.plan.md` (this file)
- (already created) `docs/specs/work-queue-dynamic-workers.md`

**Modify (7)**
- `src/main/java/com/redis/patterns/service/WorkQueueService.java`
- `src/main/java/com/redis/patterns/controller/WorkQueueController.java`
- `frontend/src/app/components/work-queue/work-queue.component.ts`
- `frontend/src/app/services/diagram-definitions.service.ts`
- `docs/specs/work-queue.md`
- `docs/TODO.md`
- `CLAUDE.md`

**Untouched (guarded by the spec):** `lua/stream_utils.lua`, `RedisStreamListenerService`,
`RedisStreamSupport`, `StreamRefreshService`, `stream-viewer`, every other pattern.

## Riskiest step & de-risking

**T5 — the interrupt.** Interrupting a Virtual Thread parked in a Jedis socket call can surface as
`JedisConnectionException` and poison a pooled connection, and the "job in flight" window is what
makes the test deterministic. De-risking, in order:

1. The window is engineered, not hoped for: `processingSleepMs = 2000` (the test seam) makes the
   interrupt land in `Thread.sleep` with ~99 % probability instead of a sub-millisecond Redis call.
2. Assertions are on **state** (`XPENDING` count, `deliveryCount`, `XINFO CONSUMERS`), never on
   timing or log output.
3. `running` is cleared **before** `interrupt()`, so the loop exits on its flag even if the interrupt
   lands somewhere unexpected; all exceptions are caught in `workerLoop`.
4. Run T5 five times (loop in T13) before declaring it green. If it flakes even once, stop and
   report rather than adding sleeps.

**Second risk — `getStreamNames()` payload break** (T1): de-risked by the T0 grep proving the
frontend never calls `/streams` today, re-run in T13.

## How tests are run, and what "done" means

```bash
mvn clean test                                          # ALWAYS clean: incremental compilation is
                                                        # unreliable on this VM's shared mount
mvn clean test -Dtest=WorkQueueScalingIntegrationTest   # single class while iterating
```

Integration tests **skip** (not fail) without Docker — if they skip in CI-less runs, that is not a
pass. Confirm the container actually ran (`docker ps -a | grep redis:8.8-alpine` during the run) at
least once.

**Done** = every acceptance box in `docs/specs/work-queue-dynamic-workers.md` ticked, T13's eight
commands run with their real output pasted, the frontend lint count no worse than T0, and the manual
`/work-queue` pass witnessed. Then, and only then, slice B (`/spec` is already written — the post)
becomes unblocked.
