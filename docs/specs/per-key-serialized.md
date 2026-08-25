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
  above the ~4s processing time) re-delivers it later, by which time the holder has released the lock.

## Time-slot lanes (spec — not yet implemented)

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
covers that slot on that worker, tinted by key. A `LOCK_SKIPPED` draws a hatched marker in the cell
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

## Acceptance
- Two jobs with the same `orderId` never run concurrently; they serialize.
- Jobs with different `orderId`s run in parallel across the 3 workers.
- A lock is only ever released by its owner (compare-and-delete), never by a different worker.
