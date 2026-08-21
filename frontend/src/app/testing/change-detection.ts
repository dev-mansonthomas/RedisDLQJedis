/**
 * Yields long enough for Angular's automatic change detection to repaint, then returns.
 *
 * Two idioms are deliberately avoided here:
 *
 * - **`fixture.detectChanges()`** checks the component view unconditionally, which defeats the whole
 *   point of an `OnPush` regression guard: the spec would pass even when the component failed to mark
 *   itself dirty. Automatic change detection (`fixture.autoDetectChanges(true)`) is what honours the
 *   dirty flag, and this helper simply gives it a turn.
 * - **`fixture.whenStable()`** never resolves for a component that owns a recurring timer — the LLM
 *   Chat page polls REST every 1500 ms, so awaiting stability there times the spec out. Waiting for a
 *   repaint is what we actually need; waiting for the app to go idle is stricter than the assertion.
 *
 * And `vi.useFakeTimers()` is not an option either: it freezes the scheduler, so signals update while
 * the DOM stays stale and every case fails for the wrong reason.
 *
 * The default delay is ordering insurance, not a measured duration: the scheduled refresh is queued
 * before this timer, so it runs first whatever the machine's load. 50 ms leaves room for a jsdom
 * `requestAnimationFrame` shim (~16 ms) on a busy CI runner. If a spec ever flakes anyway, reach for
 * Vitest's `expect.poll` rather than raising this number.
 */
export function settle(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
