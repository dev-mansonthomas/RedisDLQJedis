/** Slot width. One second reads well against the 2.7s processing time: a job spans three rows. */
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
  /**
   * The run's start, in epoch millis, but **only in the slot where it starts** — null on the rows
   * where the run merely continues.
   */
  startedAtMs: number | null;
  /**
   * The run's *reported* end, only in the slot where it ends. Null for a run still open: the
   * extrapolated end is a guess, and printing a guess to the millisecond would read as a measurement.
   */
  endedAtMs: number | null;
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

/**
 * Epoch millis as `mm:ss.SSS`.
 *
 * Sub-second precision is the whole point: two jobs on one key can share a slot without overlapping,
 * and at second resolution that hand-off is indistinguishable from a breach. The grid says which it
 * is (`overlapCount`), and these stamps let a reader check it.
 *
 * Computed from the epoch rather than through `Date`, so a half-hour-offset zone cannot shift the
 * minutes and make the reading — or its spec — depend on where it runs. Seconds and millis, which are
 * what the ordering is read from, are zone-invariant either way.
 */
export function stamp(atMs: number): string {
  const totalSeconds = Math.floor(atMs / 1000);
  const mm = Math.floor(totalSeconds / 60) % 60;
  const ss = totalSeconds % 60;
  const ms = atMs % 1000;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
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

/**
 * The end used for occupancy and overlap arithmetic: {@link runEndMs}, but never narrower than the
 * slot the run started in.
 *
 * A job whose STARTED is the newest event has `end === start` — zero width — and a zero-width
 * interval occupies no slot and overlaps nothing. Without this floor the grid would leave a running
 * job's cell empty until the next clock tick, and two simultaneous STARTEDs on one key would not
 * register as a breach until a second had passed. One slot is the model's resolution, so it is also
 * the smallest interval it can honestly represent.
 */
function effectiveEndMs(run: Run, nowMs: number, lockTtlMs: number): number {
  const end = runEndMs(run, nowMs, lockTtlMs);
  if (run.endMs !== null || run.startMs === null) return end;
  return Math.max(end, run.startMs + SLOT_MS);
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
      if (aStart < effectiveEndMs(b, nowMs, lockTtlMs)
          && bStart < effectiveEndMs(a, nowMs, lockTtlMs)) {
        pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

/**
 * The slots in which a run is part of a breach — the pair's *intersection*, not the whole run.
 *
 * A 2.7s job overlapped for its last second is only violating in that second: outlining all three
 * rows would blame the slots in which the lock was doing its job.
 */
function violatingSlots(overlaps: [Run, Run][], anchorMs: number, nowMs: number,
                        lockTtlMs: number): Map<string, Set<number>> {
  const byMessageId = new Map<string, Set<number>>();

  for (const [a, b] of overlaps) {
    const from = Math.max(a.startMs as number, b.startMs as number);
    const to = Math.min(effectiveEndMs(a, nowMs, lockTtlMs), effectiveEndMs(b, nowMs, lockTtlMs));
    const firstSlot = slotOf(from, anchorMs);
    const lastSlot = slotOf(to - 1, anchorMs);

    for (const run of [a, b]) {
      let slots = byMessageId.get(run.messageId);
      if (!slots) {
        slots = new Set<number>();
        byMessageId.set(run.messageId, slots);
      }
      for (let slot = firstSlot; slot <= lastSlot; slot++) slots.add(slot);
    }
  }
  return byMessageId;
}

export function buildGrid(runs: Run[], skips: Skip[], anchorMs: number, nowMs: number,
                          workerCount: number, lockTtlMs: number): Grid {
  const overlaps = findOverlaps(runs, nowMs, lockTtlMs);
  const violating = violatingSlots(overlaps, anchorMs, nowMs, lockTtlMs);

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
        effectiveEndMs(r, nowMs, lockTtlMs) > slotStart);

      const cellSkips = skips
        .filter(s => s.workerId === worker && s.atMs >= slotStart && s.atMs < slotEnd)
        .map(s => s.key);

      const startsHere = run?.startMs !== null && run?.startMs !== undefined
        && run.startMs >= slotStart && run.startMs < slotEnd;
      const endsHere = run?.endMs !== null && run?.endMs !== undefined
        && run.endMs >= slotStart && run.endMs < slotEnd;

      cells.push({
        key: run?.key ?? null,
        action: run?.action ?? '',
        running: run ? run.endMs === null : false,
        startedAtMs: startsHere ? (run.startMs as number) : null,
        endedAtMs: endsHere ? (run.endMs as number) : null,
        endUnknown: run ? endUnknown(run, nowMs, lockTtlMs) : false,
        skips: cellSkips,
        violating: run ? (violating.get(run.messageId)?.has(slot) ?? false) : false
      });
    }

    rows.push({ slot, startMs: slotStart, cells, violating: cells.some(c => c.violating) });
  }

  return { rows, overlapCount: overlaps.length };
}
