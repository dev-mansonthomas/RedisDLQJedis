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
  const slot = (phase: string, over: Record<string, unknown>) =>
    ({ eventType: 'PER_KEY_SLOT', phase, action: 'validate', ...over });

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

  // The grid replaced the three per-worker stream viewers on the page, so it inherits the two things
  // those headers carried: the done stream's real name and the socket's state. A column labelled
  // "worker-2" leaves a reader unable to match it against RedisInsight or a redis-cli XRANGE.
  it('labels each column with the worker\'s original done-stream name', () => {
    const names = [...host().querySelectorAll('.worker-stream')].map(e => e.textContent!.trim());

    expect(names).toEqual([
      'jobs.perkey.v1.worker1.done',
      'jobs.perkey.v1.worker2.done',
      'jobs.perkey.v1.worker3.done'
    ]);
  });

  it('shows the WebSocket status per column, live from the socket', async () => {
    const statuses = () => [...host().querySelectorAll('.worker-status')]
      .map(e => e.textContent!.trim());

    expect(statuses()).toEqual(['Connected', 'Connected', 'Connected']);
    expect(host().querySelectorAll('.worker-status.connected')).toHaveLength(3);

    socket.connection.next(false);
    await settle();

    expect(statuses()).toEqual(['Disconnected', 'Disconnected', 'Disconnected']);
    expect(host().querySelectorAll('.worker-status.disconnected')).toHaveLength(3);
  });

  it('keeps the header visible before any event has arrived', () => {
    // The header is not part of the grid body: an empty demo must still show what it is watching.
    expect(host().querySelector('.lane-row')).toBeNull();
    expect(host().querySelectorAll('.worker-stream')).toHaveLength(3);
  });

  it('explains the refusal marker below the grid, including the two counts that confuse readers', () => {
    // Both questions came from a reader of the real page: four markers on a row with three workers,
    // and markers on a row where every worker looks busy. Neither is a bug, and the grid was not
    // saying so anywhere.
    const legend = host().querySelector('.lanes-legend')!;

    expect(legend).not.toBeNull();
    expect(legend.textContent).toContain('⊘');
    expect(legend.textContent).toContain('attempt');       // per attempt, not per worker
    expect(legend.textContent).toContain('XAUTOCLAIM');    // where the retry comes from
    expect(legend.textContent!.toLowerCase()).toContain('boundary');
  });

  it('shows an empty state until the first event', () => {
    expect(host().querySelector('.lane-row')).toBeNull();
    expect(host().textContent).toContain('Submit jobs');
  });

  it('renders a running job on its worker column, tinted by key', async () => {
    socket.emit(slot('STARTED', { workerId: 2, orderId: '#1001', messageId: 'm1', atMs: 1_000_000 }));
    await settle();

    const cell = host().querySelector('.lane-row .lane-cell[data-worker="2"]')!;
    expect(cell.getAttribute('data-key')).toBe('#1001');
    expect((cell as HTMLElement).style.backgroundColor).toBeTruthy();
    expect(host().querySelector('.lane-cell[data-worker="1"]')!.getAttribute('data-key')).toBeNull();
  });

  it('ignores events from other pages on the same socket', async () => {
    socket.emit({ eventType: 'MESSAGE_PRODUCED', messageId: 'x', streamName: 'test-stream' });
    await settle();

    expect(host().querySelector('.lane-row')).toBeNull();
  });

  it('marks a row as violating when two workers hold one key at the same time', async () => {
    socket.emit(slot('STARTED', { workerId: 1, orderId: '#1001', messageId: 'm1', atMs: 1_000_000 }));
    socket.emit(slot('STARTED', { workerId: 2, orderId: '#1001', messageId: 'm2', atMs: 1_000_500 }));
    await settle();

    expect(host().querySelector('.lane-row.violating')).not.toBeNull();
    expect(host().textContent).toContain('1 overlap');
  });

  it('does not cry wolf on two adjacent jobs for the same key', async () => {
    socket.emit(slot('STARTED', { workerId: 1, orderId: '#1001', messageId: 'm1', atMs: 1_000_000 }));
    socket.emit(slot('FINISHED', { workerId: 1, orderId: '#1001', messageId: 'm1', atMs: 1_004_000 }));
    socket.emit(slot('STARTED', { workerId: 2, orderId: '#1001', messageId: 'm2', atMs: 1_004_100 }));
    await settle();

    expect(host().querySelector('.lane-row.violating')).toBeNull();
    expect(host().textContent).toContain('0 overlaps');
  });

  it('shows a refused lock on the worker that was refused', async () => {
    socket.emit(slot('STARTED', { workerId: 1, orderId: '#1001', messageId: 'm1', atMs: 1_000_000 }));
    socket.emit(slot('LOCK_SKIPPED',
      { workerId: 3, orderId: '#1001', messageId: 'm2', atMs: 1_000_400 }));
    await settle();

    expect(host().querySelector('.lane-cell[data-worker="3"] .skip-marker')).not.toBeNull();
  });

  it('labels each cell with its action, not only its key', async () => {
    socket.emit(slot('STARTED', {
      workerId: 2, orderId: '#1001', messageId: 'm1', atMs: 1_000_000, action: 'recalculateTotal'
    }));
    await settle();

    const cell = host().querySelector('.lane-row .lane-cell[data-worker="2"]')!;
    expect(cell.textContent).toContain('#1001');
    expect(cell.textContent).toContain('recalculateTotal');
  });

  // The clock rule is asserted through the rendered state, never through "rows grew after a wait":
  // the 1s tick's phase is fixed at component init, not at the first event, so waiting one slot can
  // advance the clock by less than one slot (measured: 948ms after a 1300ms wait) and the assertion
  // is racy by construction. Freezing, by contrast, is exact — nothing may advance, ever.
  it('keeps the clock running while a job is in flight', async () => {
    socket.emit(slot('STARTED', { workerId: 1, orderId: '#1001', messageId: 'm1', atMs: 1_000_000 }));
    await settle();

    expect(host().querySelector('.lanes')!.getAttribute('data-clock')).toBe('running');
  });

  it('stops the clock once nothing is in flight', async () => {
    // Otherwise a page left open after the demo drains grows a row per second for ever, and the
    // interesting slots scroll away under a wall of empty ones.
    socket.emit(slot('STARTED', { workerId: 1, orderId: '#1001', messageId: 'm1', atMs: 1_000_000 }));
    socket.emit(slot('FINISHED', { workerId: 1, orderId: '#1001', messageId: 'm1', atMs: 1_000_500 }));
    await settle();
    const before = host().querySelectorAll('.lane-row').length;

    await settle(2_300);   // two ticks of the component's 1s clock; a frozen grid must ignore both

    expect(host().querySelectorAll('.lane-row').length).toBe(before);
    expect(host().querySelector('.lanes')!.getAttribute('data-clock')).toBe('stopped');
  });

  it('stops the clock on a run left open past the lock TTL', async () => {
    // No FINISHED and the lock has expired: the job cannot still be running, so the grid must not
    // keep drawing seconds for it either.
    socket.emit(slot('STARTED', { workerId: 1, orderId: '#1001', messageId: 'm1', atMs: 1_000_000 }));
    socket.emit(slot('LOCK_SKIPPED', { workerId: 2, orderId: '#1001', messageId: 'm2', atMs: 1_031_000 }));
    await settle();

    expect(host().querySelector('.lanes')!.getAttribute('data-clock')).toBe('stopped');
  });

  it('restarts the clock when the next job arrives', async () => {
    socket.emit(slot('FINISHED', { workerId: 1, orderId: '#1001', messageId: 'm1', atMs: 1_000_000 }));
    await settle();
    expect(host().querySelector('.lanes')!.getAttribute('data-clock')).toBe('stopped');

    socket.emit(slot('STARTED', { workerId: 2, orderId: '#2002', messageId: 'm2', atMs: 1_006_000 }));
    await settle();

    expect(host().querySelector('.lanes')!.getAttribute('data-clock')).toBe('running');
    // The idle seconds are not erased — time did pass, and the gap is part of the story.
    expect(host().querySelectorAll('.lane-row').length).toBe(7);
  });

  it('tolerates a FINISHED whose STARTED was never seen', async () => {
    // The page can be opened mid-run. Dropping the event would lose a completed job entirely.
    socket.emit(slot('FINISHED', { workerId: 1, orderId: '#2002', messageId: 'm9', atMs: 1_000_000 }));
    await settle();

    expect(host().querySelector('.lane-row')).not.toBeNull();
    expect(host().querySelector('.lane-row.violating')).toBeNull();
  });
});
