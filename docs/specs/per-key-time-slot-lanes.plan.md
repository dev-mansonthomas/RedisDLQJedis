# Per-Key Time-Slot Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-key serialization guarantee visible — a grid of time slots × workers, coloured
by key, where two cells of the same colour in one row means the lock failed.

**Architecture:** The backend gains a dedicated `PerKeySlotEvent` broadcast at three points in
`PerKeySerializedService.processEntry` (lock refused / work started / work finished). The frontend
folds that event stream into runs and skips, and a set of **pure functions** turns runs into a grid
and finds interval overlaps. The component is a thin renderer over those functions, which is what
makes the logic testable without touching a clock.

**Tech Stack:** Java 21 + Jedis 8.0.0 + Spring Boot 4.1.1 (Jackson 3, `tools.jackson`), Angular 22
standalone + signals + OnPush, Vitest via `@angular/build:unit-test`.

**Spec:** [`docs/specs/per-key-serialized.md`](per-key-serialized.md), section **Time-slot lanes**.

## Global Constraints

- **No new dependencies**, backend or frontend. Everything below uses APIs already in the project.
- **Angular components are `ChangeDetectionStrategy.OnPush`**; mutable template state lives in a
  `signal()` and is **replaced**, never mutated in place.
- **Templates use built-in control flow** (`@if` / `@for`), never `*ngIf` / `*ngFor`.
- **Every `<label>` is associated with a control.** A caption labelling a *group* is
  `<span class="group-label">`, not a `<label>`.
- **`npm run lint` must stay at 0 errors** and `mvn clean test` at **0 skipped**.
- **`mvn test` without `clean` is unreliable in this VM** (shared-mount mtimes) — always
  `mvn clean test`.
- Slot size is **1000 ms**; worker count is **3** (`PerKeySerializedService.NUM_WORKERS`); processing
  time is **4000 ms** (`PROCESSING_SLEEP_MS`); lock TTL is **30000 ms** (`LOCK_TTL_MS`); the grid keeps
  the most recent **120** slots.
- `eventType` on every socket event is the discriminator. This one is always the literal
  `PER_KEY_SLOT`.

---

## Ground truth from the existing code (do not re-derive)

- **`WebSocketEventService.broadcastEvent` is overloaded per DTO** — `DLQEvent` (line ~111),
  `PubSubEvent` (~195), `LlmChatEvent` (~262). Each one repeats the same four guards: `shuttingDown`
  check, empty-`sessions` check, `objectMapper.writeValueAsString`, then send. Task 2 adds a fourth
  overload in that shape. Do **not** refactor the three existing ones into a generic method — that is
  a separate change and not in scope.
- **The frontend union is `export type StreamEvent = DLQEvent | PubSubEvent`**
  (`frontend/src/app/services/websocket.service.ts:40`). `LlmChatEvent` is deliberately outside it.
  Task 5 adds `PerKeySlotEvent` to that union.
- **Components discriminate on `eventType` before touching any other field** — see
  `pubsub-subscriber.component.ts:260`: `if (event.eventType === 'MESSAGE_RECEIVED' && …)`. Follow it.
- **`PerKeySerializedIntegrationTest` constructs the service by hand** (lines 53-55):
  ```java
  var ws = new WebSocketEventService(new ObjectMapper());
  listener = new RedisStreamListenerService(servicePool, ws);
  service = new PerKeySerializedService(servicePool, ws, listener);
  ```
  So a **recording subclass of `WebSocketEventService`** can be injected with no Spring, no mocking
  library. That is how Task 3 asserts on emitted events.
- **`PerKeySerializedService.processEntry` already has the three places** the events belong: the
  `if (lockResult == null)` early return, the line before `Thread.sleep(PROCESSING_SLEEP_MS)`, and the
  point just after `jedis.xadd(doneStream, …)`. No new branches are needed.
- **`getOrderColor(orderId)` lives on `PerKeySerializedComponent`** and maps six keys
  (`#1001`..`#6006`) to six hex colours, defaulting to `#64748b`. Task 4 moves it out; the default
  must survive the move.
- **`settle()` (`src/app/testing/change-detection.ts`)** is the only way to let an OnPush view
  repaint in a spec. `fixture.detectChanges()` defeats the guard, `fixture.whenStable()` never
  resolves for a component owning a recurring timer, and `vi.useFakeTimers()` freezes Angular's
  scheduler. All three are documented traps — do not rediscover them.
- **`WebSocketServiceStub` (`src/app/testing/websocket.stub.ts`)** drives `getEvents()` by hand.
  jsdom has no WebSocket, so a spec must never let the real service build SockJS.

---

## Task 1: Slot and overlap model (pure functions)

The whole judgement of the feature lives here, deliberately outside Angular so it can be tested
without a clock, a socket, or a DOM.

**Files:**
- Create: `frontend/src/app/components/per-key-lanes/slot-model.ts`
- Test: `frontend/src/app/components/per-key-lanes/slot-model.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface Run { messageId: string; workerId: number; key: string; action: string;
                         startMs: number | null; endMs: number | null; }
  export interface Skip { workerId: number; key: string; atMs: number; }
  export interface Cell { key: string | null; action: string; running: boolean;
                          endUnknown: boolean; skips: string[]; violating: boolean; }
  export interface Row { slot: number; startMs: number; cells: Cell[]; violating: boolean; }
  export interface Grid { rows: Row[]; overlapCount: number; }

  export const SLOT_MS = 1000;
  export const MAX_SLOTS = 120;

  export function slotOf(atMs: number, anchorMs: number): number;
  export function runEndMs(run: Run, nowMs: number, lockTtlMs: number): number;
  export function findOverlaps(runs: Run[], nowMs: number, lockTtlMs: number): [Run, Run][];
  export function buildGrid(runs: Run[], skips: Skip[], anchorMs: number, nowMs: number,
                            workerCount: number, lockTtlMs: number): Grid;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';

import {
  buildGrid, findOverlaps, runEndMs, slotOf, MAX_SLOTS, Run, Skip
} from './slot-model';

const LOCK_TTL = 30_000;
const run = (over: Partial<Run> & { messageId: string; workerId: number; key: string }): Run => ({
  action: 'validate', startMs: 0, endMs: null, ...over
});

describe('slotOf', () => {
  it('bins a timestamp into a 1s slot relative to the anchor', () => {
    expect(slotOf(1_000, 1_000)).toBe(0);
    expect(slotOf(1_999, 1_000)).toBe(0);
    expect(slotOf(2_000, 1_000)).toBe(1);
    expect(slotOf(5_500, 1_000)).toBe(4);
  });

  it('never returns a negative slot for an event older than the anchor', () => {
    // A FINISHED can arrive before its STARTED, so the anchor is not guaranteed to be the minimum.
    expect(slotOf(500, 1_000)).toBe(0);
  });
});

describe('runEndMs', () => {
  it('uses the recorded end when the run finished', () => {
    expect(runEndMs(run({ messageId: 'a', workerId: 1, key: '#1', startMs: 0, endMs: 4_000 }),
      99_000, LOCK_TTL)).toBe(4_000);
  });

  it('extends an open run to now while it is still plausibly running', () => {
    expect(runEndMs(run({ messageId: 'a', workerId: 1, key: '#1', startMs: 0 }), 2_500, LOCK_TTL))
      .toBe(2_500);
  });

  it('caps an abandoned run at the lock TTL instead of growing for ever', () => {
    // The lock expires after LOCK_TTL, so a run still open past that cannot still hold the key.
    expect(runEndMs(run({ messageId: 'a', workerId: 1, key: '#1', startMs: 0 }), 90_000, LOCK_TTL))
      .toBe(30_000);
  });
});

describe('findOverlaps', () => {
  it('finds two runs on the same key whose intervals overlap', () => {
    const a = run({ messageId: 'a', workerId: 1, key: '#1001', startMs: 0, endMs: 4_000 });
    const b = run({ messageId: 'b', workerId: 2, key: '#1001', startMs: 3_000, endMs: 7_000 });

    expect(findOverlaps([a, b], 10_000, LOCK_TTL)).toEqual([[a, b]]);
  });

  it('does NOT flag two adjacent runs on the same key', () => {
    // The whole reason violations are judged on intervals and not on slot collision: these two share
    // slot 4 and are exactly what the lock working correctly looks like.
    const a = run({ messageId: 'a', workerId: 1, key: '#1001', startMs: 0, endMs: 4_000 });
    const b = run({ messageId: 'b', workerId: 2, key: '#1001', startMs: 4_100, endMs: 8_100 });

    expect(findOverlaps([a, b], 10_000, LOCK_TTL)).toEqual([]);
  });

  it('ignores overlapping runs on different keys — that is the parallelism half of the claim', () => {
    const a = run({ messageId: 'a', workerId: 1, key: '#1001', startMs: 0, endMs: 4_000 });
    const b = run({ messageId: 'b', workerId: 2, key: '#2002', startMs: 0, endMs: 4_000 });

    expect(findOverlaps([a, b], 10_000, LOCK_TTL)).toEqual([]);
  });

  it('skips runs whose start is unknown', () => {
    const a = run({ messageId: 'a', workerId: 1, key: '#1001', startMs: null, endMs: 4_000 });
    const b = run({ messageId: 'b', workerId: 2, key: '#1001', startMs: 0, endMs: 4_000 });

    expect(findOverlaps([a, b], 10_000, LOCK_TTL)).toEqual([]);
  });
});

describe('buildGrid', () => {
  it('fills one cell per slot a run covers, on that run\'s worker column', () => {
    const grid = buildGrid(
      [run({ messageId: 'a', workerId: 2, key: '#1001', startMs: 0, endMs: 3_000 })],
      [], 0, 3_000, 3, LOCK_TTL);

    expect(grid.rows).toHaveLength(4);            // slots 0..3
    expect(grid.rows[0].cells[1].key).toBe('#1001');
    expect(grid.rows[0].cells[0].key).toBeNull();
    expect(grid.rows[2].cells[1].key).toBe('#1001');
  });

  it('marks the cells and rows of an overlapping pair, and counts the pair once', () => {
    const grid = buildGrid([
      run({ messageId: 'a', workerId: 1, key: '#1001', startMs: 0, endMs: 4_000 }),
      run({ messageId: 'b', workerId: 2, key: '#1001', startMs: 1_000, endMs: 5_000 })
    ], [], 0, 5_000, 3, LOCK_TTL);

    expect(grid.overlapCount).toBe(1);            // one pair, not one per outlined row
    expect(grid.rows[1].violating).toBe(true);
    expect(grid.rows[1].cells[0].violating).toBe(true);
    expect(grid.rows[1].cells[1].violating).toBe(true);
    expect(grid.rows[0].violating).toBe(false);   // only worker 1 is busy in slot 0
  });

  it('records a refused lock on the worker that was refused', () => {
    const skips: Skip[] = [{ workerId: 3, key: '#1001', atMs: 1_200 }];
    const grid = buildGrid(
      [run({ messageId: 'a', workerId: 1, key: '#1001', startMs: 0, endMs: 4_000 })],
      skips, 0, 4_000, 3, LOCK_TTL);

    expect(grid.rows[1].cells[2].skips).toEqual(['#1001']);
  });

  it('keeps only the most recent MAX_SLOTS rows', () => {
    const grid = buildGrid(
      [run({ messageId: 'a', workerId: 1, key: '#1001', startMs: 0, endMs: 1_000 })],
      [], 0, (MAX_SLOTS + 40) * 1_000, 3, LOCK_TTL);

    expect(grid.rows).toHaveLength(MAX_SLOTS);
    expect(grid.rows[grid.rows.length - 1].slot).toBe(MAX_SLOTS + 40);
  });

  it('returns no rows before anything has happened', () => {
    expect(buildGrid([], [], 0, 0, 3, LOCK_TTL).rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/app/components/per-key-lanes/slot-model.spec.ts`
(or `npm test` — the project runs Vitest through `@angular/build:unit-test`)
Expected: FAIL — `Could not resolve "./slot-model"`.

- [ ] **Step 3: Write the implementation**

```ts
/** Slot width. One second reads well against the 4s processing time: a job spans four rows. */
export const SLOT_MS = 1000;

/** Rows retained. A demo page left open must not grow without bound. */
export const MAX_SLOTS = 120;

/** One attempt at one job by one worker. `endMs` is null while it is still running. */
export interface Run {
  messageId: string;
  workerId: number;
  key: string;
  action: string;
  /** Null when the page opened mid-run and only the FINISHED was seen. */
  startMs: number | null;
  endMs: number | null;
}

/** A worker that tried a key another worker held. This refusal IS the pattern. */
export interface Skip {
  workerId: number;
  key: string;
  atMs: number;
}

export interface Cell {
  key: string | null;
  action: string;
  running: boolean;
  /** The run outlived the lock TTL without a FINISHED, so its end is a guess. */
  endUnknown: boolean;
  skips: string[];
  violating: boolean;
}

export interface Row {
  slot: number;
  startMs: number;
  cells: Cell[];
  violating: boolean;
}

export interface Grid {
  rows: Row[];
  /** Distinct overlapping PAIRS of runs, not outlined rows: one overlap spanning four slots counts once. */
  overlapCount: number;
}

export function slotOf(atMs: number, anchorMs: number): number {
  return Math.max(0, Math.floor((atMs - anchorMs) / SLOT_MS));
}

/**
 * When a run stops occupying its worker.
 *
 * An open run extends to `nowMs` — it really is still running. But past the lock's TTL it cannot
 * still hold the key (Redis has expired the lock), so it is capped there instead of painting a bar
 * that grows for the rest of the session.
 */
export function runEndMs(run: Run, nowMs: number, lockTtlMs: number): number {
  if (run.endMs !== null) return run.endMs;
  const start = run.startMs ?? nowMs;
  return Math.min(nowMs, start + lockTtlMs);
}

function endUnknown(run: Run, nowMs: number, lockTtlMs: number): boolean {
  return run.endMs === null && run.startMs !== null && nowMs > run.startMs + lockTtlMs;
}

/**
 * Pairs of runs that held the same key at the same time.
 *
 * Judged on the `[start, end)` intervals, never on two cells landing in the same slot: a job ending
 * at t=4.0s and the next on the same key starting at t=4.1s share slot 4 without overlapping, and
 * that is the lock working. Slot collision would cry wolf on the happy path.
 */
export function findOverlaps(runs: Run[], nowMs: number, lockTtlMs: number): [Run, Run][] {
  const dated = runs.filter(r => r.startMs !== null);
  const pairs: [Run, Run][] = [];

  for (let i = 0; i < dated.length; i++) {
    for (let j = i + 1; j < dated.length; j++) {
      const a = dated[i];
      const b = dated[j];
      if (a.key !== b.key) continue;
      const aStart = a.startMs as number;
      const bStart = b.startMs as number;
      if (aStart < runEndMs(b, nowMs, lockTtlMs) && bStart < runEndMs(a, nowMs, lockTtlMs)) {
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

export function buildGrid(runs: Run[], skips: Skip[], anchorMs: number, nowMs: number,
                          workerCount: number, lockTtlMs: number): Grid {
  const overlaps = findOverlaps(runs, nowMs, lockTtlMs);
  const violatingIds = new Set(overlaps.flat().map(r => r.messageId));

  const lastSlot = slotOf(nowMs, anchorMs);
  const firstSlot = Math.max(0, lastSlot - MAX_SLOTS + 1);

  const rows: Row[] = [];
  for (let slot = firstSlot; slot <= lastSlot; slot++) {
    const slotStart = anchorMs + slot * SLOT_MS;
    const slotEnd = slotStart + SLOT_MS;
    const cells: Cell[] = [];

    for (let worker = 1; worker <= workerCount; worker++) {
      const run = runs.find(r =>
        r.workerId === worker &&
        r.startMs !== null &&
        (r.startMs as number) < slotEnd &&
        runEndMs(r, nowMs, lockTtlMs) > slotStart);

      const cellSkips = skips
        .filter(s => s.workerId === worker && s.atMs >= slotStart && s.atMs < slotEnd)
        .map(s => s.key);

      cells.push({
        key: run?.key ?? null,
        action: run?.action ?? '',
        running: run ? run.endMs === null : false,
        endUnknown: run ? endUnknown(run, nowMs, lockTtlMs) : false,
        skips: cellSkips,
        violating: run ? violatingIds.has(run.messageId) : false
      });
    }

    rows.push({ slot, startMs: slotStart, cells, violating: cells.some(c => c.violating) });
  }

  return { rows, overlapCount: overlaps.length };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm test`
Expected: PASS, and the total test count rises by 15.

- [ ] **Step 5: Lint**

Run: `cd frontend && npm run lint`
Expected: `All files pass linting.`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/components/per-key-lanes/slot-model.ts \
        frontend/src/app/components/per-key-lanes/slot-model.spec.ts
git commit -m "feat(per-key): slot binning and overlap detection as pure functions

Violations are judged on interval overlap, not on two cells landing in the
same slot: a job ending at 4.0s and the next on the same key starting at
4.1s share slot 4 without overlapping, and that is the lock working
correctly. An open run is capped at the lock TTL so an abandoned one does
not paint a bar for the rest of the session.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: `PerKeySlotEvent` DTO and its broadcast overload

**Files:**
- Create: `src/main/java/com/redis/patterns/dto/PerKeySlotEvent.java`
- Modify: `src/main/java/com/redis/patterns/service/WebSocketEventService.java` (add a fourth
  `broadcastEvent` overload, in the shape of the `PubSubEvent` one at ~line 195)
- Test: `src/test/java/com/redis/patterns/dto/PerKeySlotEventTest.java`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```java
  PerKeySlotEvent.builder()
      .phase(PerKeySlotEvent.Phase.STARTED)   // STARTED | FINISHED | LOCK_SKIPPED
      .workerId(int).orderId(String).action(String).messageId(String).atMs(long)
      .build();
  // getEventType() always returns "PER_KEY_SLOT"
  void WebSocketEventService.broadcastEvent(PerKeySlotEvent event)
  ```

- [ ] **Step 1: Write the failing test**

```java
package com.redis.patterns.dto;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The wire shape is the contract with the browser, so it is asserted rather than assumed.
 *
 * <p>`atMs` in particular must stay a JSON *number*: the frontend bins it into slots and compares
 * intervals, and a quoted timestamp would silently become string arithmetic.
 */
class PerKeySlotEventTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void serialisesWithANumericTimestampAndTheDiscriminator() {
        PerKeySlotEvent event = PerKeySlotEvent.builder()
                .phase(PerKeySlotEvent.Phase.STARTED)
                .workerId(2)
                .orderId("#1001")
                .action("recalculateTotal")
                .messageId("1787-0")
                .atMs(1_787_000_000_123L)
                .build();

        String json = mapper.writeValueAsString(event);

        assertThat(json).contains("\"eventType\":\"PER_KEY_SLOT\"");
        assertThat(json).contains("\"phase\":\"STARTED\"");
        assertThat(json).contains("\"atMs\":1787000000123");
        assertThat(json).doesNotContain("\"atMs\":\"");
    }

    @Test
    void carriesTheDiscriminatorForEveryPhase() {
        for (PerKeySlotEvent.Phase phase : PerKeySlotEvent.Phase.values()) {
            PerKeySlotEvent event = PerKeySlotEvent.builder().phase(phase).workerId(1)
                    .orderId("#1").action("a").messageId("m").atMs(1L).build();
            assertThat(event.getEventType()).isEqualTo("PER_KEY_SLOT");
        }
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `mvn clean test -Dtest=PerKeySlotEventTest`
Expected: FAIL — `cannot find symbol: class PerKeySlotEvent`.

- [ ] **Step 3: Write the DTO**

```java
package com.redis.patterns.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * One state change in the Per-Key Serialized demo: a worker started a job, finished one, or was
 * refused a key another worker held.
 *
 * <p>A dedicated DTO rather than a new {@code DLQEvent.EventType}: {@code DLQEvent} is consumed by
 * {@code stream-viewer} on all twelve pattern pages, and its payload (payload / deliveryCount /
 * failureKind) has nothing to do with worker occupancy. Same precedent as {@code PubSubEvent}.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PerKeySlotEvent {

    /**
     * Discriminator. Every event on this socket carries one, and consumers filter on it before
     * touching any other field.
     */
    @Builder.Default
    private String eventType = "PER_KEY_SLOT";

    private Phase phase;

    /** 1..NUM_WORKERS — the grid column. */
    private int workerId;

    /** The business key (an orderId). Drives the cell's background colour. */
    private String orderId;

    private String action;

    /** Correlates a STARTED with its FINISHED. */
    private String messageId;

    /**
     * Epoch millis, deliberately not a {@code LocalDateTime}: the frontend does arithmetic on this
     * (slot binning, interval overlap), and a zone-less local time is ambiguous for that. The other
     * DTOs keep {@code @JsonFormat} because they only ever display their timestamp.
     */
    private long atMs;

    public enum Phase {
        /** Lock acquired; work is about to begin. Emitted BEFORE the simulated processing. */
        STARTED,
        /** Work done and copied to the worker's done stream. */
        FINISHED,
        /** The key was held by another worker, so this one moved on without blocking. */
        LOCK_SKIPPED
    }
}
```

- [ ] **Step 4: Add the broadcast overload**

In `WebSocketEventService`, after the `broadcastEvent(PubSubEvent)` method, add — mirroring its
guards exactly, including the `shuttingDown` check that keeps shutdown silent:

```java
    /**
     * Broadcasts a Per-Key slot event to all connected WebSocket clients.
     *
     * <p>Same shape as {@link #broadcastEvent(PubSubEvent)}; kept as a separate overload rather than
     * generified, because unifying the four is a refactor of its own.
     *
     * @param event The slot event to broadcast
     */
    public void broadcastEvent(PerKeySlotEvent event) {
        if (shuttingDown.get()) {
            log.debug("Shutting down, dropping PerKeySlotEvent broadcast");
            return;
        }
        if (sessions.isEmpty()) {
            log.trace("No active WebSocket sessions, skipping broadcast");
            return;
        }

        try {
            String message = objectMapper.writeValueAsString(event);
            if (message == null) {
                log.error("Failed to serialize PerKeySlotEvent to JSON");
                return;
            }
            broadcastText(new TextMessage(message));
        } catch (Exception e) {
            log.error("Failed to broadcast PerKeySlotEvent: {}", e.getMessage());
        }
    }
```

**Before writing this, read the existing `broadcastEvent(PubSubEvent)` in full.** If it sends inline
over `sessions` instead of delegating to a helper, copy *that* structure rather than inventing
`broadcastText` — match the file, do not improve it in this task. Add
`import com.redis.patterns.dto.PerKeySlotEvent;` if the file imports DTOs individually.

- [ ] **Step 5: Run the test to verify it passes**

Run: `mvn clean test -Dtest=PerKeySlotEventTest`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/java/com/redis/patterns/dto/PerKeySlotEvent.java \
        src/main/java/com/redis/patterns/service/WebSocketEventService.java \
        src/test/java/com/redis/patterns/dto/PerKeySlotEventTest.java
git commit -m "feat(per-key): add PerKeySlotEvent and its broadcast overload

A dedicated DTO rather than a new DLQEvent.EventType: DLQEvent is consumed
by stream-viewer on all twelve pages and its payload has nothing to do with
worker occupancy. atMs is epoch millis because the frontend does arithmetic
on it; the wire shape is asserted so a quoted timestamp cannot slip through.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Emit the three events from the service

**Files:**
- Modify: `src/main/java/com/redis/patterns/service/PerKeySerializedService.java` (`processEntry`)
- Test: `src/test/java/com/redis/patterns/service/PerKeySlotEventsIntegrationTest.java`

**Interfaces:**
- Consumes: `PerKeySlotEvent` + the overload from Task 2.
- Produces: the event stream Task 5 renders. No new public method.

- [ ] **Step 1: Write the failing test**

```java
package com.redis.patterns.service;

import com.redis.patterns.dto.PerKeySlotEvent;
import com.redis.patterns.support.AbstractRedisIntegrationTest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The lanes can only be as truthful as these events. A recording subclass of the broadcaster is
 * enough — the service is constructed by hand here, so no Spring and no mocking library.
 */
class PerKeySlotEventsIntegrationTest extends AbstractRedisIntegrationTest {

    /** Captures what the service broadcasts. */
    static class RecordingWs extends WebSocketEventService {
        final List<PerKeySlotEvent> slots = new CopyOnWriteArrayList<>();

        RecordingWs() {
            super(new ObjectMapper());
        }

        @Override
        public void broadcastEvent(PerKeySlotEvent event) {
            slots.add(event);
        }
    }

    private RecordingWs ws;
    private PerKeySerializedService service;

    @BeforeEach
    void setUp() throws Exception {
        ws = new RecordingWs();
        var listener = new RedisStreamListenerService(jedisPool, ws);
        service = new PerKeySerializedService(jedisPool, ws, listener);
        try (var jedis = jedisPool.getResource()) {
            jedis.functionLoadReplace(Files.readString(Path.of("lua/stream_utils.lua")));
        }
        service.run();
    }

    @Test
    void aProcessedJobEmitsStartedThenFinished() throws Exception {
        service.submitJobs(List.of(Map.of("orderId", "#7001", "action", "validate")));

        awaitTrue(() -> phases("#7001").contains(PerKeySlotEvent.Phase.FINISHED),
                Duration.ofSeconds(30), "the job to finish");

        List<PerKeySlotEvent.Phase> phases = phases("#7001");
        assertThat(phases).startsWith(PerKeySlotEvent.Phase.STARTED);
        assertThat(phases).contains(PerKeySlotEvent.Phase.FINISHED);

        PerKeySlotEvent started = forKey("#7001").getFirst();
        assertThat(started.getWorkerId()).isBetween(1, 3);
        assertThat(started.getAction()).isEqualTo("validate");
        assertThat(started.getMessageId()).isNotBlank();
        assertThat(started.getAtMs()).isGreaterThan(0L);
    }

    @Test
    void startedPrecedesTheProcessingWindow_notTrailingIt() throws Exception {
        // STARTED must be emitted BEFORE the 4s sleep, or a running job only appears once it is over
        // and the grid can never show occupancy.
        long submittedAt = System.currentTimeMillis();
        service.submitJobs(List.of(Map.of("orderId", "#7002", "action", "validate")));

        awaitTrue(() -> !forKey("#7002").isEmpty(), Duration.ofSeconds(15), "the STARTED event");

        PerKeySlotEvent started = forKey("#7002").getFirst();
        assertThat(started.getPhase()).isEqualTo(PerKeySlotEvent.Phase.STARTED);
        assertThat(started.getAtMs() - submittedAt)
                .as("STARTED lands well inside the 4000ms processing window, not after it")
                .isLessThan(3_000L);
    }

    @Test
    void aWorkerRefusedTheKeyEmitsLockSkipped() throws Exception {
        // Three jobs on ONE key against three workers: two of them must be turned away.
        service.submitJobs(List.of(
                Map.of("orderId", "#7003", "action", "a"),
                Map.of("orderId", "#7003", "action", "b"),
                Map.of("orderId", "#7003", "action", "c")));

        awaitTrue(() -> phases("#7003").contains(PerKeySlotEvent.Phase.LOCK_SKIPPED),
                Duration.ofSeconds(30), "a refused lock");

        PerKeySlotEvent skipped = forKey("#7003").stream()
                .filter(e -> e.getPhase() == PerKeySlotEvent.Phase.LOCK_SKIPPED)
                .findFirst().orElseThrow();
        assertThat(skipped.getWorkerId()).isBetween(1, 3);
        assertThat(skipped.getOrderId()).isEqualTo("#7003");
    }

    private List<PerKeySlotEvent> forKey(String key) {
        return ws.slots.stream().filter(e -> key.equals(e.getOrderId())).toList();
    }

    private List<PerKeySlotEvent.Phase> phases(String key) {
        return forKey(key).stream().map(PerKeySlotEvent::getPhase).toList();
    }

    /** Local poller — Awaitility is not a dependency of this project and must not become one. */
    private void awaitTrue(BooleanSupplier condition, Duration timeout, String what)
            throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeout.toMillis();
        while (System.currentTimeMillis() < deadline) {
            if (condition.getAsBoolean()) return;
            Thread.sleep(50);
        }
        throw new AssertionError("Timed out waiting for " + what);
    }
}
```

**Read `PerKeySerializedIntegrationTest` before running this**: copy how it names the pool
(`jedisPool` vs a local `servicePool`) and whether it stops the workers in an `@AfterEach`. Match that
file — a leaked worker pool makes the next test in the class flake.

- [ ] **Step 2: Run the test to verify it fails**

Run: `mvn clean test -Dtest=PerKeySlotEventsIntegrationTest`
Expected: FAIL — the three assertions find an empty `ws.slots`, because nothing emits yet.

- [ ] **Step 3: Emit from `processEntry`**

Three edits in `PerKeySerializedService.processEntry`. First, in the refusal branch, right after the
existing `log.info("Worker-{}: orderId={} is LOCKED, …")`:

```java
            webSocketEventService.broadcastEvent(PerKeySlotEvent.builder()
                .phase(PerKeySlotEvent.Phase.LOCK_SKIPPED)
                .workerId(workerId).orderId(orderId).action(action)
                .messageId(messageId).atMs(System.currentTimeMillis())
                .build());
            return;
```

Second, inside the `try`, immediately before `Thread.sleep(PROCESSING_SLEEP_MS)` — **before**, so a
running job is visible while it runs rather than only once it is over:

```java
            webSocketEventService.broadcastEvent(PerKeySlotEvent.builder()
                .phase(PerKeySlotEvent.Phase.STARTED)
                .workerId(workerId).orderId(orderId).action(action)
                .messageId(messageId).atMs(System.currentTimeMillis())
                .build());

            // Simulate processing
            Thread.sleep(PROCESSING_SLEEP_MS);
```

Third, right after `jedis.xadd(doneStream, XAddParams.xAddParams(), doneFields);`:

```java
            webSocketEventService.broadcastEvent(PerKeySlotEvent.builder()
                .phase(PerKeySlotEvent.Phase.FINISHED)
                .workerId(workerId).orderId(orderId).action(action)
                .messageId(messageId).atMs(System.currentTimeMillis())
                .build());
```

Add `import com.redis.patterns.dto.PerKeySlotEvent;`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `mvn clean test -Dtest=PerKeySlotEventsIntegrationTest`
Expected: PASS, 3 tests. If `aWorkerRefusedTheKeyEmitsLockSkipped` is flaky, it means all three jobs
were handed to one worker; raise the submitted job count to 5 rather than adding a sleep.

- [ ] **Step 5: Run the whole backend suite**

Run: `mvn clean test`
Expected: **146 tests** (141 + 2 from Task 2 + 3 here), 0 failures, 0 errors, **0 skipped**.

- [ ] **Step 6: Commit**

```bash
git add src/main/java/com/redis/patterns/service/PerKeySerializedService.java \
        src/test/java/com/redis/patterns/service/PerKeySlotEventsIntegrationTest.java
git commit -m "feat(per-key): emit slot events for start, finish and refused lock

STARTED is emitted before the simulated processing, not after it: a job
that only appears once it is over cannot show occupancy, which is the whole
point of the grid. The refused lock was previously a log line only, and it
is the mechanism a viewer most needs to see.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Share the key colour

The job list and the grid must tint `#1001` identically; two palettes would make cross-reading the
two panels actively misleading.

**Files:**
- Create: `frontend/src/app/services/key-color.ts`
- Test: `frontend/src/app/services/key-color.spec.ts`
- Modify: `frontend/src/app/components/per-key-serialized/per-key-serialized.component.ts` (delete its
  private `getOrderColor`, delegate to the shared one)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function keyColor(key: string): string` — the six known keys map to their existing
  hex values; anything else returns `'#64748b'`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

import { keyColor } from './key-color';

describe('keyColor', () => {
  it('keeps the six demo keys on the colours the page already used', () => {
    expect(keyColor('#1001')).toBe('#3b82f6');
    expect(keyColor('#2002')).toBe('#10b981');
    expect(keyColor('#3003')).toBe('#f59e0b');
    expect(keyColor('#4004')).toBe('#8b5cf6');
    expect(keyColor('#5005')).toBe('#ec4899');
    expect(keyColor('#6006')).toBe('#14b8a6');
  });

  it('falls back to slate for a key outside the palette', () => {
    // The grid still labels the cell, so two uncoloured keys stay distinguishable by text.
    expect(keyColor('#9999')).toBe('#64748b');
    expect(keyColor('')).toBe('#64748b');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test`
Expected: FAIL — `Could not resolve "./key-color"`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Background colour for a business key.
 *
 * Shared rather than private to a component: the job list and the time-slot grid must tint the same
 * key identically, or reading one against the other is worse than having no colour at all.
 */
const KEY_COLORS: Record<string, string> = {
  '#1001': '#3b82f6',  // blue
  '#2002': '#10b981',  // green
  '#3003': '#f59e0b',  // orange
  '#4004': '#8b5cf6',  // purple
  '#5005': '#ec4899',  // pink
  '#6006': '#14b8a6'   // teal
};

/** Slate, for any key outside the demo palette. The cell keeps its text label. */
export const UNKNOWN_KEY_COLOR = '#64748b';

export function keyColor(key: string): string {
  return KEY_COLORS[key] ?? UNKNOWN_KEY_COLOR;
}
```

- [ ] **Step 4: Point the existing component at it**

In `per-key-serialized.component.ts`, delete the private `getOrderColor` body and delegate, so the
template needs no change:

```ts
  getOrderColor(orderId: string): string {
    return keyColor(orderId);
  }
```

Add `import { keyColor } from '../../services/key-color';`.

- [ ] **Step 5: Run the tests and lint**

Run: `cd frontend && npm test && npm run lint`
Expected: PASS (+2 tests), `All files pass linting.`

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/services/key-color.ts frontend/src/app/services/key-color.spec.ts \
        frontend/src/app/components/per-key-serialized/per-key-serialized.component.ts
git commit -m "refactor(per-key): share the key colour between the job list and the grid

Two palettes for one key would make cross-reading the panels worse than
having no colour at all. Same six hex values, same slate fallback.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: `PerKeyLanesComponent`

**Files:**
- Create: `frontend/src/app/components/per-key-lanes/per-key-lanes.component.ts`
- Test: `frontend/src/app/components/per-key-lanes/per-key-lanes.component.spec.ts`
- Modify: `frontend/src/app/services/websocket.service.ts` (add `PerKeySlotEvent`, extend the
  `StreamEvent` union at line 40)
- Modify: `frontend/src/app/components/per-key-serialized/per-key-serialized.component.html` (place
  the grid) and `.ts` (import the component)

**Interfaces:**
- Consumes: `buildGrid`, `Run`, `Skip`, `SLOT_MS`, `MAX_SLOTS` (Task 1); `keyColor` (Task 4);
  `WebSocketService.getEvents()`.
- Produces: `<app-per-key-lanes>`, and in `websocket.service.ts`:
  ```ts
  export interface PerKeySlotEvent {
    eventType: string;                                     // 'PER_KEY_SLOT'
    phase: 'STARTED' | 'FINISHED' | 'LOCK_SKIPPED';
    workerId: number; orderId: string; action: string; messageId: string; atMs: number;
  }
  export type StreamEvent = DLQEvent | PubSubEvent | PerKeySlotEvent;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { PerKeyLanesComponent } from './per-key-lanes.component';
import { WebSocketService } from '../../services/websocket.service';
import { WebSocketServiceStub } from '../../testing/websocket.stub';
import { settle } from '../../testing/change-detection';

/**
 * The grid's judgement lives in `slot-model.ts` and is tested there. This spec covers the wiring: do
 * socket events reach the DOM, and does an overlap actually paint as a violation.
 *
 * This component owns a 1s tick, so `fixture.whenStable()` would never resolve — `settle()` only,
 * and never `vi.useFakeTimers()`, which freezes Angular's scheduler.
 */
describe('PerKeyLanesComponent', () => {
  let fixture: ComponentFixture<PerKeyLanesComponent>;
  let socket: WebSocketServiceStub;

  const host = () => fixture.nativeElement as HTMLElement;
  const slot = (phase: string, over: Record<string, unknown>) => ({
    eventType: 'PER_KEY_SLOT', phase, action: 'validate', ...over
  });

  beforeEach(async () => {
    socket = new WebSocketServiceStub();
    await TestBed.configureTestingModule({
      imports: [PerKeyLanesComponent],
      providers: [{ provide: WebSocketService, useValue: socket }]
    }).compileComponents();

    fixture = TestBed.createComponent(PerKeyLanesComponent);
    fixture.autoDetectChanges(true);
    await settle();
  });

  it('shows an empty state until the first event', () => {
    expect(host().querySelector('.lane-row')).toBeNull();
    expect(host().textContent).toContain('Submit jobs');
  });

  it('renders a running job on its worker column, tinted by key', async () => {
    socket.events.next(slot('STARTED',
      { workerId: 2, orderId: '#1001', messageId: 'm1', atMs: 1_000_000 }));
    await settle();

    const cell = host().querySelector('.lane-row .lane-cell[data-worker="2"]')!;
    expect(cell.getAttribute('data-key')).toBe('#1001');
    expect((cell as HTMLElement).style.backgroundColor).toBeTruthy();
    expect(host().querySelector('.lane-cell[data-worker="1"]')!.getAttribute('data-key')).toBeNull();
  });

  it('ignores events from other pages on the same socket', async () => {
    socket.events.next({ eventType: 'MESSAGE_PRODUCED', messageId: 'x', streamName: 'test-stream' });
    await settle();

    expect(host().querySelector('.lane-row')).toBeNull();
  });

  it('marks a row as violating when two workers hold one key at the same time', async () => {
    socket.events.next(slot('STARTED',
      { workerId: 1, orderId: '#1001', messageId: 'm1', atMs: 1_000_000 }));
    socket.events.next(slot('STARTED',
      { workerId: 2, orderId: '#1001', messageId: 'm2', atMs: 1_000_500 }));
    await settle();

    expect(host().querySelector('.lane-row.violating')).not.toBeNull();
    expect(host().textContent).toContain('1 overlap');
  });

  it('does not cry wolf on two adjacent jobs for the same key', async () => {
    socket.events.next(slot('STARTED',
      { workerId: 1, orderId: '#1001', messageId: 'm1', atMs: 1_000_000 }));
    socket.events.next(slot('FINISHED',
      { workerId: 1, orderId: '#1001', messageId: 'm1', atMs: 1_004_000 }));
    socket.events.next(slot('STARTED',
      { workerId: 2, orderId: '#1001', messageId: 'm2', atMs: 1_004_100 }));
    await settle();

    expect(host().querySelector('.lane-row.violating')).toBeNull();
    expect(host().textContent).toContain('0 overlaps');
  });

  it('shows a refused lock on the worker that was refused', async () => {
    socket.events.next(slot('STARTED',
      { workerId: 1, orderId: '#1001', messageId: 'm1', atMs: 1_000_000 }));
    socket.events.next(slot('LOCK_SKIPPED',
      { workerId: 3, orderId: '#1001', messageId: 'm2', atMs: 1_000_400 }));
    await settle();

    expect(host().querySelector('.lane-cell[data-worker="3"] .skip-marker')).not.toBeNull();
  });

  it('tolerates a FINISHED whose STARTED was never seen', async () => {
    // The page can be opened mid-run. Dropping the event would lose a completed job entirely.
    socket.events.next(slot('FINISHED',
      { workerId: 1, orderId: '#2002', messageId: 'm9', atMs: 1_000_000 }));
    await settle();

    expect(host().querySelector('.lane-row')).not.toBeNull();
    expect(host().querySelector('.lane-row.violating')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npm test`
Expected: FAIL — `Could not resolve "./per-key-lanes.component"`.

- [ ] **Step 3: Extend the socket types**

In `websocket.service.ts`, after the `PubSubEvent` interface:

```ts
/**
 * Per-Key Serialized slot events (backend `PerKeySlotEvent`). One state change of one worker:
 * `atMs` is epoch millis because the grid does arithmetic on it.
 */
export interface PerKeySlotEvent {
  eventType: string;
  phase: 'STARTED' | 'FINISHED' | 'LOCK_SKIPPED';
  workerId: number;
  orderId: string;
  action: string;
  messageId: string;
  atMs: number;
}
```

and widen the union:

```ts
export type StreamEvent = DLQEvent | PubSubEvent | PerKeySlotEvent;
```

**Then run `npm run lint` and `npm test` immediately.** Widening a union that `stream-viewer` and
`pubsub-subscriber` already narrow by `eventType` can surface type errors in those files; fix them by
narrowing (`if (event.eventType === '…')`) rather than by casting.

- [ ] **Step 4: Write the component**

```ts
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal }
  from '@angular/core';
import { Subscription } from 'rxjs';

import { PerKeySlotEvent, StreamEvent, WebSocketService } from '../../services/websocket.service';
import { keyColor } from '../../services/key-color';
import { buildGrid, Run, Skip, SLOT_MS } from './slot-model';

/** Workers the service runs (`PerKeySerializedService.NUM_WORKERS`). */
const WORKERS = 3;

/** `PerKeySerializedService.LOCK_TTL_MS` — how long an abandoned run can still hold a key. */
const LOCK_TTL_MS = 30_000;

@Component({
  selector: 'app-per-key-lanes',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="lanes">
      <header class="lanes-header">
        <h3 class="lanes-title">⏱ Time slots — one row per second, one column per worker</h3>
        <span class="overlap-count" [class.bad]="grid().overlapCount > 0">
          {{ grid().overlapCount }}
          {{ grid().overlapCount === 1 ? 'overlap' : 'overlaps' }}
        </span>
      </header>

      @if (grid().rows.length === 0) {
        <p class="empty">Submit jobs to watch the workers fill the slots.</p>
      } @else {
        <div class="grid-head">
          <span class="slot-label"></span>
          @for (worker of workers; track worker) {
            <span class="worker-label">worker-{{ worker }}</span>
          }
        </div>

        @for (row of grid().rows; track row.slot) {
          <div class="lane-row" [class.violating]="row.violating">
            <span class="slot-label">t+{{ row.slot }}s</span>
            @for (cell of row.cells; track $index) {
              <span class="lane-cell"
                    [attr.data-worker]="$index + 1"
                    [attr.data-key]="cell.key"
                    [class.running]="cell.running"
                    [class.violating]="cell.violating"
                    [style.background-color]="cell.key ? keyColor(cell.key) : ''"
                    [title]="cell.key ? cell.key + ' — ' + cell.action : ''">
                @if (cell.key) {
                  <span class="cell-key">{{ cell.key }}</span>
                }
                @if (cell.endUnknown) {
                  <span class="unknown" title="No FINISHED seen; the lock TTL has expired">?</span>
                }
                @for (skip of cell.skips; track $index) {
                  <span class="skip-marker"
                        [title]="'worker was refused ' + skip + ' — another worker held it'">⃠</span>
                }
              </span>
            }
          </div>
        }
      }
    </section>
    `,
  styles: [`
    .lanes { background: white; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
    .lanes-header {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 10px 14px; border-bottom: 1px solid #e2e8f0;
      background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
    }
    .lanes-title { margin: 0; font-size: 14px; font-weight: 600; color: #1e293b; }
    .overlap-count {
      padding: 2px 8px; border-radius: 10px; background: #dcfce7; color: #166534;
      font-size: 11px; font-weight: 700;
    }
    .overlap-count.bad { background: #fee2e2; color: #991b1b; }
    .empty { margin: 0; padding: 16px; font-size: 13px; color: #64748b; }
    .grid-head, .lane-row {
      display: grid; grid-template-columns: 56px repeat(3, minmax(0, 1fr));
      gap: 2px; padding: 0 8px;
    }
    .grid-head { padding-top: 8px; padding-bottom: 4px; }
    .worker-label, .slot-label {
      font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase;
    }
    .lane-row { align-items: stretch; }
    .lane-row.violating { outline: 2px solid #dc2626; outline-offset: -1px; border-radius: 3px; }
    .slot-label { display: flex; align-items: center; font-family: 'Courier New', monospace; }
    .lane-cell {
      display: flex; align-items: center; gap: 4px; min-height: 20px; padding: 1px 6px;
      border-radius: 3px; background: #f8fafc; color: white;
      font-size: 10px; font-weight: 700;
    }
    .lane-cell.running { box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.6); }
    .lane-cell.violating { outline: 2px solid #dc2626; }
    .cell-key { text-shadow: 0 1px 1px rgba(0, 0, 0, 0.35); }
    .skip-marker { color: #b91c1c; background: #fee2e2; border-radius: 2px; padding: 0 3px; }
    .unknown { color: #fef3c7; }
  `]
})
export class PerKeyLanesComponent implements OnInit, OnDestroy {
  private readonly ws = inject(WebSocketService);
  private subscription?: Subscription;
  private tick?: ReturnType<typeof setInterval>;

  readonly workers = Array.from({ length: WORKERS }, (_, i) => i + 1);
  readonly keyColor = keyColor;

  /**
   * State is replaced wholesale on every update, never mutated: an OnPush view reading a mutated
   * object never repaints, which is the regression this codebase has already paid for once.
   */
  private readonly runs = signal<Run[]>([]);
  private readonly skips = signal<Skip[]>([]);
  private readonly anchorMs = signal<number | null>(null);

  /**
   * Backend clock, corrected once. `atMs` comes from the backend container and `Date.now()` from the
   * host — comparing them raw would drift. The tick below advances this so a running job grows.
   */
  private readonly clockOffsetMs = signal(0);
  private readonly nowMs = signal(0);

  readonly grid = computed(() => {
    const anchor = this.anchorMs();
    if (anchor === null) return { rows: [], overlapCount: 0 };
    return buildGrid(this.runs(), this.skips(), anchor, this.nowMs(), WORKERS, LOCK_TTL_MS);
  });

  ngOnInit(): void {
    this.subscription = this.ws.getEvents().subscribe((event: StreamEvent) => {
      if (event.eventType !== 'PER_KEY_SLOT') return;
      this.absorb(event as PerKeySlotEvent);
    });
    this.tick = setInterval(() => {
      if (this.anchorMs() !== null) this.nowMs.set(Date.now() + this.clockOffsetMs());
    }, SLOT_MS);
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    if (this.tick !== undefined) clearInterval(this.tick);
  }

  private absorb(event: PerKeySlotEvent): void {
    if (this.anchorMs() === null) {
      this.anchorMs.set(event.atMs);
      this.clockOffsetMs.set(event.atMs - Date.now());
    }
    this.nowMs.set(Math.max(this.nowMs(), event.atMs));

    if (event.phase === 'LOCK_SKIPPED') {
      this.skips.set([...this.skips(),
        { workerId: event.workerId, key: event.orderId, atMs: event.atMs }]);
      return;
    }

    const existing = this.runs().find(r => r.messageId === event.messageId);
    if (existing) {
      // A FINISHED closing a run we already know, or a STARTED for one we only saw finish.
      this.runs.set(this.runs().map(r => r.messageId !== event.messageId ? r : {
        ...r,
        startMs: event.phase === 'STARTED' ? event.atMs : r.startMs,
        endMs: event.phase === 'FINISHED' ? event.atMs : r.endMs
      }));
      return;
    }

    this.runs.set([...this.runs(), {
      messageId: event.messageId,
      workerId: event.workerId,
      key: event.orderId,
      action: event.action,
      // A FINISHED with no STARTED means the page opened mid-run: keep it, with an unknown start.
      startMs: event.phase === 'STARTED' ? event.atMs : null,
      endMs: event.phase === 'FINISHED' ? event.atMs : null
    }]);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npm test`
Expected: PASS (+7 tests). If `renders a running job … tinted by key` fails on
`style.backgroundColor`, check the `[style.background-color]` binding — jsdom returns `''` when the
value is empty, so the assertion only holds for a cell that has a key.

- [ ] **Step 6: Place the grid on the page**

In `per-key-serialized.component.html`, insert the grid between the `main-layout` block and the
`explanation-section`, so it sits under the streams and above the prose:

```html
  <!-- The guarantee, made visible: one row per second, one column per worker, one colour per key.
       Two cells of the same colour in one row is the failure the lock exists to prevent. -->
  <app-per-key-lanes></app-per-key-lanes>
```

In `per-key-serialized.component.ts`, add `PerKeyLanesComponent` to `imports` and import it.

- [ ] **Step 7: Lint and run everything**

Run: `cd frontend && npm test && npm run lint`
Expected: PASS, `All files pass linting.`

- [ ] **Step 8: Commit**

```bash
git add frontend/src/app/components/per-key-lanes/ \
        frontend/src/app/services/websocket.service.ts \
        frontend/src/app/components/per-key-serialized/
git commit -m "feat(per-key): render the time-slot grid

Rows are seconds, columns are workers, background is the key: two cells of
the same colour in one row is the failure the lock exists to prevent. The
judgement lives in slot-model.ts, so this component is a renderer plus a
clock — and the clock is offset-corrected, because atMs is the backend
container's time and Date.now() is the host's.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Verify against the running stack, then document

A green suite does not prove a demo reads well. This task is where the claim gets checked.

**Files:**
- Modify: `docs/specs/per-key-serialized.md` (drop "not yet implemented" from the section title)
- Modify: `docs/TODO.md` (close the legibility item)
- Modify: `CLAUDE.md` (the `/per-key-serialized` row, the frontend test count, and the new DTO in the
  cross-cutting facts)

- [ ] **Step 1: Rebuild and run the walkthrough**

```bash
docker compose up -d --build backend frontend
```

Then, in a browser at `http://localhost:4200/per-key-serialized`, submit the default batch (5 jobs on
`#1001`, one each on `#2002`..`#6006`) and check every acceptance criterion from the spec:

- no row holds two cells of the same colour;
- the five `#1001` jobs occupy consecutive, non-overlapping slot ranges;
- different keys visibly share rows (the parallelism half of the claim);
- at least one `⃠` refusal marker appears while `#1001` is held;
- the overlap counter reads `0 overlaps`;
- the browser console is clean.

Capture a screenshot. **If the counter is not 0, stop and report it** — that is either a real
serialization bug in the service or a bug in the detector, and both matter more than shipping the
grid.

- [ ] **Step 2: Prove the detector can fail**

A grid that is always green proves nothing. Confirm the violation path renders by temporarily
lowering `RECLAIM_MIN_IDLE_MS` in `PerKeySerializedService` from `10000` to `1000` — below the 4000 ms
processing time — which is the documented way to make a free worker steal an in-flight job. Rebuild,
submit the batch, and confirm a red-outlined row and a non-zero counter appear. **Then revert the
constant** and rebuild.

Record the result in `docs/TODO.md`: this is the same failure mode that shipped 120 duplicated jobs in
the Work Queue, and the grid is now able to show it.

- [ ] **Step 3: Update the docs**

- In `docs/specs/per-key-serialized.md`, retitle the section
  `## Time-slot lanes (spec — not yet implemented)` → `## Time-slot lanes`, and add the measured
  result of Step 2 under **Acceptance (lanes)**.
- In `docs/TODO.md`, close the 🟠 *"Per-Key Serialized: the guarantee does not jump out"* item with
  what was built, the measured walkthrough, and the Step 2 proof.
- In `CLAUDE.md`: extend the `/per-key-serialized` table row with the grid and `PerKeySlotEvent`; bump
  the frontend test count; add one line to the cross-cutting facts saying that per-key occupancy
  travels on `PerKeySlotEvent`, **not** `DLQEvent`, and why.

- [ ] **Step 4: Full gate**

```bash
mvn clean test                  # expect 146 tests, 0 failures, 0 skipped
cd frontend && npm test         # expect +24 tests over the 57 baseline
cd frontend && npm run lint     # expect 0 errors
luacheck lua/ --globals redis cjson cmsgpack bit   # unchanged: 0/0
```

- [ ] **Step 5: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs(per-key): record the time-slot lanes and how the detector was proven

A grid that is always green proves nothing, so the violation path was
exercised by lowering RECLAIM_MIN_IDLE_MS below the processing time — the
documented way to make a free worker steal an in-flight job — and the row
did outline. The constant is back where it was.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review

**Spec coverage.** Every section of the spec maps to a task: *Why* → Task 6 Step 1; *Event contract* →
Tasks 2 and 3; *Frontend model* → Tasks 1 and 5; *Violation rule* → Task 1 (`findOverlaps`, with the
adjacency case asserted); *Clock, timers and bounds* → Task 1 (`MAX_SLOTS`) and Task 5 (offset + tick);
*Edge cases* → Task 1 (open run capped at TTL, negative slot, same key sequentially) and Task 5
(`FINISHED` before `STARTED`, colour fallback via Task 4); *Acceptance (lanes)* → Task 6.

**Placeholders.** None: every code step carries the code, every test step the assertions, and every
run step the command with its expected output.

**Type consistency.** `Run` / `Skip` / `Cell` / `Row` / `Grid` are declared once in Task 1 and used
with those exact field names in Task 5. `keyColor` (Task 4) is the name used in Task 5's template.
`PerKeySlotEvent`'s Java field names (`phase`, `workerId`, `orderId`, `action`, `messageId`, `atMs`)
match the TypeScript interface in Task 5 one-for-one, which is what makes the JSON line up.

**Known risk left in the open:** Task 5's `absorb` keeps runs and skips for the life of the page.
`buildGrid` bounds the *rows* it renders to `MAX_SLOTS`, but the arrays themselves keep growing, and
`findOverlaps` is O(n²) over them. For a demo page that is fine; if a run ever exceeds a few thousand
events, prune the arrays to the retained slot window in `absorb`. Stated rather than silently
accepted.
