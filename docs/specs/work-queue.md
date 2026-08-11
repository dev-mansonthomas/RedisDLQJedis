# Spec — Work Queue (Competing Consumers)

Route `/work-queue` · `WorkQueueController` (`/api/work-queue`) · `WorkQueueService` ·
Lua `read_claim_or_dlq`.

## Goal
Distribute jobs across N parallel workers sharing **one** consumer group; each job processed by
exactly one worker. Failed jobs retry then go to DLQ. The pool size is adjustable at runtime so the
page can demonstrate scaling and crash recovery.

## Redis
- Input `jobs.imageProcessing.v1`, group `jobs-group`, DLQ `jobs.imageProcessing.v1:dlq`.
- Per-worker done streams `jobs.done.worker-{1..count}`.
- `FCALL read_claim_or_dlq 2 <stream> <dlq> jobs-group worker-{id} <minIdle> 1 2`
  (`minIdle` = the active demo mode's, `count=1`, `maxDeliver=2`).

## Demo mode (timing preset)

The page's pace is one of two presets, switchable at runtime (`WorkQueueService.DemoMode`, in memory,
`FAST` at startup):

| Mode | Simulated work | `minIdle` | Poll | Producer sleep (advisory) | Burst | For |
|------|---------------:|----------:|-----:|--------------------------:|------:|-----|
| `SLOW` | 2000 ms | 5000 ms | 500 ms | 2000 ms | 20 | Step-by-step narration: one job per worker is watchable, a killed worker's job sits PENDING ~5 s |
| `FAST` | 50 ms | 500 ms | 50 ms | 100 ms | 200 | Counters climbing: retry + DLQ routing land inside a second |

- **Work time and `minIdle` move together, never independently** — they are coupled by the invariant
  below, so the REST surface exposes one `mode`, not two knobs.
- **`producerSleepMs` is advisory**: the producer loop runs in the browser, so the frontend applies it
  to its own "Sleep between jobs" control when the mode changes.
- Switching mode retimes the **running** workers (next loop iteration); no restart, no respawn. A job
  already in flight finishes at the old work time.
- `burstSize` is the mode's one-click backlog, sized to drain in a watchable 5–60 s at the 4-worker
  default (`WorkQueueDemoModeTest#aBurstDrainsInAWatchableTime`).

## Throughput counter & burst

- **The steady producer never builds a backlog.** In `FAST` a single worker already handles ~10 jobs/s
  (50 ms work + 50 ms poll), which is the browser producer's own rate. So the completion rate tracks the
  *producer*, not the pool, and adding workers changes nothing visible. **`POST /produce/burst` exists to
  fix exactly that**: queue `burstSize` jobs in one pipelined round trip, then watch the drain rate scale
  with the worker count (≈10/s at 1 worker, ≈80/s at 8).
- **The counter needs no backend support.** Every done-stream entry already reaches the browser as a
  `MESSAGE_PRODUCED` WebSocket event, because `spawnWorker()` registers `startMonitoring(jobs.done.worker-N)`.
  The page counts events whose `streamName` starts with `streams.doneStreamPrefix` — the prefix, not the
  `doneStreams` list, so a job finished by a just-removed worker still counts.
- Rate = sliding window of arrival times (`computeRate()`, pure and exported for a future test runner),
  width `max(5000, 3 × workMs)` so `SLOW` holds enough samples. The span is floored at 1 s, so two
  completions 30 ms apart cannot report 66/s. Recomputed on a 400 ms timer, not per event: the figure must
  decay to 0 when production stops, and OnPush change detection stays at 2.5 Hz instead of ~80 Hz.
- **A job routed to the DLQ is not a completion**, so `Completed` trails `Jobs produced` by the 1-in-10
  failures. Stated in the chip's tooltip.

## Worker pool
- **1 to 8 workers** (`MIN_WORKERS` / `MAX_WORKERS`), **4 at startup** (`INITIAL_WORKERS`).
- Ids are always contiguous `1..count`: add → `count+1`, remove → the **highest** id (hence no id
  parameter on the REST calls).
- In-memory only — **not** persisted, **not** in `application.yml`; a restart returns to 4.
- A new worker joins the group implicitly on its first read (no `XGROUP CREATECONSUMER`).

## REST
- `POST /produce?processingType=OK|Error` — `XADD` a job (`OK` succeeds, `Error` fails to trigger retry/DLQ).
- `POST /produce/burst?count=200` — `XADD` `count` jobs in **one pipelined round trip**; every 10th is
  `Error`. → `{success, count, firstMessageId, lastMessageId}` (bounds, not 1000 ids); **400** outside
  `1..MAX_BURST` (1000).
- `GET /streams` — `{success, streams:{jobStream, dlqStream, group, doneStreams:[…], doneStreamPrefix},
  workers:{count,min,max}, demoMode:{…}}`. `doneStreams` is an **array** (one entry per running worker),
  not numbered keys.
- `GET /demo-mode` — `{success, mode, label, workMs, minIdleMs, pollMs, producerSleepMs,
  modes:[{name,label,workMs,minIdleMs,pollMs,producerSleepMs}]}`. `workMs`/`minIdleMs`/`pollMs` are the
  **effective** values; `modes` is the option list the dropdown labels itself with, so the UI never
  hard-codes a timing.
- `PUT /demo-mode?mode=SLOW|FAST` — apply a preset (case-insensitive) → same payload as `GET`;
  **400** naming the accepted values when `mode` is unknown.
- `GET /workers` — `{success, count, min, max, consumers:[{id,name,doneStream}]}`.
- `POST /workers` — add one worker → `{success, count, added:{…}}`; **409** at `MAX_WORKERS`.
- `DELETE /workers?kill=false|true` — remove the highest-id worker → `{success, count, kill, removed:{…}, note}`;
  **409** at `MIN_WORKERS`.
  - `kill=false` (default) **graceful**: the in-flight job is completed (`XADD` done + `XACK`) before the loop exits.
  - `kill=true` **abrupt**: the Virtual Thread is interrupted, so `processMessage` returns without
    `XADD`/`XACK` and the job stays in the PEL for another worker to reclaim.
- `DELETE /clear` — delete the job stream, the DLQ and done streams `1..MAX_WORKERS`, then recreate the group.

## Flow
Each worker is a Virtual Thread polling at the demo mode's interval via `FCALL read_claim_or_dlq`.
`OK` jobs → copied to the worker's done stream + `XACK`. `Error` jobs → not ACK'd → reclaimed →
DLQ after 2 deliveries.

## Invariants / edge cases
- **`XGROUP DELCONSUMER` is never issued.** Removing a worker leaves its consumer in the group;
  deleting it would drop its pending entries and lose the in-flight job.
- **Monitoring is not stopped** when a worker is removed, so re-adding is a no-op and there is no
  stop/start race on the blocking `XREAD`.
- **`minIdle` must exceed the maximum processing time.** Otherwise a *free* worker claims a job its
  busy peer is still processing and the job is processed twice, silently (no error, empty PEL, empty
  DLQ). Measured on the running page with the former 100 ms / 100 ms pair: **120 of 266** completed
  jobs were duplicated. Every `DemoMode` therefore enforces `minIdleMs >= 2 * workMs` in its
  constructor, guarded by `WorkQueueDemoModeTest` (no Redis needed) and
  `WorkQueueScalingIntegrationTest#neitherShippedModeLetsAFreeWorkerStealAnInFlightJob`; the failure
  mode itself is characterized by `…#aFreeWorkerStealsAnInFlightJobWhenProcessingExceedsMinIdle`.
- **Killing costs one delivery.** Kill the holder of the same job twice and it reaches
  `maxDeliver=2` → DLQ.
- Done streams of removed workers keep their data (only `/clear` deletes) but their panels are hidden.
- `stopWorkers()` joins the worker threads: a worker parked in its processing sleep would otherwise
  keep consuming after shutdown returns.

## Acceptance
- `OK` job processed by exactly one worker, appears in that worker's done stream.
- `Error` job lands in DLQ after 2 attempts.
- Adding a worker adds a done-stream panel that fills; the new consumer appears in `XINFO CONSUMERS`.
- Killing a worker mid-job leaves the job PENDING (`deliveryCount=1`), keeps the consumer, and another
  worker completes it.
- Pool bounds are enforced with **409** and no state change.

Tests: `WorkQueueScalingIntegrationTest` (9), `WorkQueueWorkersControllerTest` (7).
Frontend has no test runner (`docs/TODO.md`) → verified via lint, build and a manual pass.
