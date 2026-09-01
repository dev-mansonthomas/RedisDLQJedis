import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { WebSocketService } from './websocket.service';
import { WebSocketServiceStub } from '../testing/websocket.stub';

/**
 * Contract tests for `getConnectionStatus()`. No socket is opened here — jsdom has no WebSocket, and
 * the property under test is what a subscriber sees, not what the transport does.
 *
 * <p>Why this file exists: `connectionStatus` was a plain `Subject`, which emits only on a
 * *transition*. The service is a root singleton, so its socket outlives a route change — meaning any
 * component created after the socket opened subscribed to a source that would never speak again, and
 * rendered "Disconnected" forever. `stream-viewer` hid this by seeding itself from `isConnected()`
 * after subscribing; `per-key-lanes` did not, so its three column badges read "Disconnected" on every
 * SPA navigation into the page (reproduced in a browser: 4/4 badges Connected on a cold load, 3/4
 * Disconnected when reached from `/dlq`).
 */
describe('WebSocketService connection status contract', () => {
  it('replays the current status to a subscriber that arrives late', () => {
    const service = TestBed.configureTestingModule({}).inject(WebSocketService);

    const seen: boolean[] = [];
    service.getConnectionStatus().subscribe(v => seen.push(v));

    // A late subscriber must be told where things stand, not left waiting for the next transition.
    expect(seen).toEqual([false]);
  });

  it('replays the latest status, not the initial one', () => {
    const service = TestBed.configureTestingModule({}).inject(WebSocketService);

    // Stand in for the socket callbacks (`onopen`/`onclose`), which cannot run under jsdom.
    (service as unknown as { connectionStatus: { next(v: boolean): void } })
      .connectionStatus.next(true);

    const seen: boolean[] = [];
    service.getConnectionStatus().subscribe(v => seen.push(v));

    expect(seen).toEqual([true]);
  });

  /**
   * The bug above was invisible to 13 spec files because `WebSocketServiceStub` already used a
   * `BehaviorSubject` — the stub was *more capable* than the service it stands for, so no test could
   * observe a source that never replays. Pin them together.
   */
  it('matches the stub, which every component spec is written against', () => {
    const service = TestBed.configureTestingModule({}).inject(WebSocketService);
    const stub = new WebSocketServiceStub();

    const fromService: boolean[] = [];
    const fromStub: boolean[] = [];
    service.getConnectionStatus().subscribe(v => fromService.push(v));
    stub.getConnectionStatus().subscribe(v => fromStub.push(v));

    expect(fromService).toHaveLength(fromStub.length);
  });
});
