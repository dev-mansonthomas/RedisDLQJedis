import { describe, expect, it } from 'vitest';
import { computeRate } from './work-queue.component';

/**
 * `computeRate` is the work-queue throughput counter. It was previously "verified" by measuring the
 * rendered page by hand (`docs/specs/frontend-test-runner.md`), which is neither repeatable nor a
 * regression guard — hence these cases.
 */
describe('computeRate', () => {
  const WINDOW = 5_000;

  it('returns 0 with no samples', () => {
    expect(computeRate([], 10_000, WINDOW)).toBe(0);
  });

  it('returns 0 for a single sample, because a rate needs two points', () => {
    expect(computeRate([9_900], 10_000, WINDOW)).toBe(0);
  });

  it('floors the span at one second, so two samples 30ms apart are not reported as 66/s', () => {
    const rate = computeRate([9_970, 10_000], 10_000, WINDOW);

    expect(rate).toBeLessThanOrEqual(2);
    expect(rate).toBe(2); // 2 samples over the 1s floor
  });

  it('reports the steady-state rate: 50 samples spread over exactly 5s in a 5s window', () => {
    const now = 100_000;
    const times = Array.from({ length: 50 }, (_, i) => now - WINDOW + i * (WINDOW / 50));

    expect(computeRate(times, now, WINDOW)).toBe(10);
  });

  it('decays to 0 once every sample has left the window', () => {
    const now = 100_000;
    const stale = [now - 20_000, now - 19_000, now - 18_000];

    expect(computeRate(stale, now, WINDOW)).toBe(0);
  });

  it('ignores samples outside the window', () => {
    const now = 100_000;
    // 3 stale + 2 in-window: only the in-window pair counts, over the 1s floor
    const mixed = [now - 30_000, now - 20_000, now - 10_000, now - 400, now - 200];

    expect(computeRate(mixed, now, WINDOW)).toBe(2);
  });
});
