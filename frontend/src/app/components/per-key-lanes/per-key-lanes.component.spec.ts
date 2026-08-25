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

  it('tolerates a FINISHED whose STARTED was never seen', async () => {
    // The page can be opened mid-run. Dropping the event would lose a completed job entirely.
    socket.emit(slot('FINISHED', { workerId: 1, orderId: '#2002', messageId: 'm9', atMs: 1_000_000 }));
    await settle();

    expect(host().querySelector('.lane-row')).not.toBeNull();
    expect(host().querySelector('.lane-row.violating')).toBeNull();
  });
});
