import { Observable, BehaviorSubject, Subject } from 'rxjs';
import { StreamEvent } from '../services/websocket.service';

/**
 * Stand-in for {@link WebSocketService} in specs.
 *
 * jsdom has no WebSocket, so a spec must never let the real service construct a SockJS handle
 * (`docs/specs/frontend-test-runner.md`). Beyond that, driving the event stream by hand is the point:
 * it is what lets a spec assert that an incoming event actually reaches the DOM.
 */
export class WebSocketServiceStub {
  readonly events = new Subject<StreamEvent>();
  readonly connection = new BehaviorSubject<boolean>(true);
  readonly sent: unknown[] = [];
  connectCalls = 0;

  connect(): void {
    this.connectCalls++;
  }

  disconnect(): void {
    // no-op
  }

  getEvents(): Observable<StreamEvent> {
    return this.events.asObservable();
  }

  getConnectionStatus(): Observable<boolean> {
    return this.connection.asObservable();
  }

  isConnected(): boolean {
    return this.connection.value;
  }

  send(payload: unknown): void {
    this.sent.push(payload);
  }

  /** Pushes an event as the backend would. */
  emit(event: Record<string, unknown>): void {
    this.events.next(event as unknown as StreamEvent);
  }
}
