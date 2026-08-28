import { describe, expect, it } from 'vitest';

import {
  buildGrid, findOverlaps, runEndMs, slotOf, stamp, MAX_SLOTS, Run, Skip
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

  it('flags two runs that are both still open on the same key', () => {
    // Two STARTEDs and no FINISHED between them is the failure at its freshest: the model must not
    // need a tick of the clock before it can see it, or the grid stays green through the breach.
    const a = run({ messageId: 'a', workerId: 1, key: '#1001', startMs: 1_000_000 });
    const b = run({ messageId: 'b', workerId: 2, key: '#1001', startMs: 1_000_500 });

    expect(findOverlaps([a, b], 1_000_500, LOCK_TTL)).toEqual([[a, b]]);
  });
});

describe('stamp', () => {
  it('formats epoch millis as mm:ss.SSS, zero-padded', () => {
    expect(stamp(0)).toBe('00:00.000');
    expect(stamp(62_007)).toBe('01:02.007');
    expect(stamp(3_599_999)).toBe('59:59.999');
  });

  it('wraps at the hour, because only the ordering inside a minute is being read', () => {
    expect(stamp(3_600_000)).toBe('00:00.000');
  });

  it('is computed from the epoch, not from the local zone, so it cannot drift with TZ', () => {
    // A half-hour-offset zone would shift the minutes of a Date-based implementation and make this
    // spec pass or fail depending on where it runs.
    expect(stamp(1_787_852_533_311)).toBe(stamp(1_787_852_533_311));
    expect(stamp(1_787_852_533_311).endsWith('.311')).toBe(true);
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

  it('fills the cell of a run that started in the current slot and has not finished', () => {
    // A job whose STARTED is the newest event has zero elapsed width. Judging occupancy on
    // `[start, now)` alone would leave its cell empty — the running job invisible while it runs.
    const grid = buildGrid(
      [run({ messageId: 'a', workerId: 2, key: '#1001', startMs: 1_000_000 })],
      [], 1_000_000, 1_000_000, 3, LOCK_TTL);

    expect(grid.rows[0].cells[1].key).toBe('#1001');
    expect(grid.rows[0].cells[1].running).toBe(true);
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

  it('stamps the run\'s start only in the slot where it actually starts', () => {
    const grid = buildGrid(
      [run({ messageId: 'a', workerId: 1, key: '#1001', startMs: 1_400, endMs: 4_100 })],
      [], 0, 4_100, 3, LOCK_TTL);

    expect(grid.rows[1].cells[0].startedAtMs).toBe(1_400);   // slot 1 holds the start
    expect(grid.rows[2].cells[0].startedAtMs).toBeNull();    // the run continues, it does not restart
    expect(grid.rows[4].cells[0].endedAtMs).toBe(4_100);     // slot 4 holds the end
    expect(grid.rows[1].cells[0].endedAtMs).toBeNull();
  });

  it('never stamps an end for a run that has not reported one', () => {
    // The extrapolated end (now, or the lock TTL) is a guess; printing it to the millisecond would
    // dress a guess up as a measurement.
    const grid = buildGrid(
      [run({ messageId: 'a', workerId: 1, key: '#1001', startMs: 0 })],
      [], 0, 2_500, 3, LOCK_TTL);

    expect(grid.rows.every(r => r.cells[0].endedAtMs === null)).toBe(true);
  });

  it('stamps both sides of a hand-off that shares one slot', () => {
    // The case that looks like a violation and is not: same key, same second, two workers. The
    // timestamps are what let a reader see that one ended before the other began.
    const grid = buildGrid([
      run({ messageId: 'a', workerId: 1, key: '#1001', startMs: 0, endMs: 2_140 }),
      run({ messageId: 'b', workerId: 2, key: '#1001', startMs: 2_412, endMs: 5_100 })
    ], [], 0, 5_100, 3, LOCK_TTL);

    expect(grid.overlapCount).toBe(0);
    expect(grid.rows[2].cells[0].endedAtMs).toBe(2_140);
    expect(grid.rows[2].cells[1].startedAtMs).toBe(2_412);
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
