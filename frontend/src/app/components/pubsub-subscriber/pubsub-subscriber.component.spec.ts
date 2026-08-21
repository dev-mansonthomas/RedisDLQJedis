import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { PubsubSubscriberComponent } from './pubsub-subscriber.component';
import { WebSocketService } from '../../services/websocket.service';
import { WebSocketServiceStub } from '../../testing/websocket.stub';
import { settle } from '../../testing/change-detection';

/**
 * Change-detection regression guard.
 *
 * This component is `OnPush`, and nothing about that is enforced by the compiler or by lint: it
 * renders incoming WebSocket messages only because its state lives in a `signal()` that is replaced,
 * never mutated in place. Write `messages.update(m => { m.unshift(x); return m; })` instead and the
 * view silently stops refreshing while every other counter on the page keeps moving — the failure
 * mode `docs/TODO.md` records as unguarded.
 *
 * **The refresh here must go through `ApplicationRef.tick()`, not `fixture.detectChanges()`.**
 * `detectChanges()` checks the component view unconditionally, so it would paper over exactly the
 * bug this spec exists to catch; `tick()` walks from the root and skips OnPush views that were never
 * marked dirty.
 */
describe('PubsubSubscriberComponent — OnPush refresh', () => {
  let fixture: ComponentFixture<PubsubSubscriberComponent>;
  let ws: WebSocketServiceStub;

  const render = async () => {
    await settle();
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  };

  beforeEach(async () => {
    ws = new WebSocketServiceStub();
    await TestBed.configureTestingModule({
      imports: [PubsubSubscriberComponent],
      providers: [{ provide: WebSocketService, useValue: ws }]
    }).compileComponents();

    fixture = TestBed.createComponent(PubsubSubscriberComponent);
    fixture.componentInstance.channel = 'fire-and-forget';
    fixture.autoDetectChanges(true);
    await settle();
  });

  it('starts empty', async () => {
    expect(await render()).toContain('No messages received yet');
  });

  it('renders a message that arrives on its channel', async () => {
    ws.emit({
      eventType: 'MESSAGE_RECEIVED',
      channel: 'fire-and-forget',
      payload: { orderId: 'ORD-42' },
      timestamp: '2026-08-21T10:00:00Z'
    });

    const text = await render();
    expect(text).toContain('ORD-42');
    expect(text).not.toContain('No messages received yet');
  });

  it('ignores a message published on another channel', async () => {
    ws.emit({
      eventType: 'MESSAGE_RECEIVED',
      channel: 'some-other-channel',
      payload: { orderId: 'ORD-99' },
      timestamp: '2026-08-21T10:00:00Z'
    });

    const text = await render();
    expect(text).not.toContain('ORD-99');
    expect(text).toContain('No messages received yet');
  });

  it('keeps rendering each further message, newest first', async () => {
    for (const id of ['ORD-1', 'ORD-2', 'ORD-3']) {
      ws.emit({
        eventType: 'MESSAGE_RECEIVED',
        channel: 'fire-and-forget',
        payload: { orderId: id },
        timestamp: '2026-08-21T10:00:00Z'
      });
    }

    const text = await render();
    expect(text).toContain('ORD-1');
    expect(text).toContain('ORD-3');
    expect(text.indexOf('ORD-3')).toBeLessThan(text.indexOf('ORD-1'));
  });
});
