import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { StreamViewerComponent } from './stream-viewer.component';
import { WebSocketService } from '../../services/websocket.service';
import { WebSocketServiceStub } from '../../testing/websocket.stub';
import { settle } from '../../testing/change-detection';

/**
 * Guards for the two header annotations: why an entry was dead-lettered, and how the last attempt
 * failed.
 *
 * The first case is a regression guard, not a happy path. The DLQ page generates `order.cancelled`
 * payloads carrying a **business** `reason` field (`customer_request`, `fraud_detected`), so a viewer
 * that keys the "why it was dead-lettered" line off the field *name* labels a healthy entry in the
 * main stream as dead-lettered. That was observed in a browser before this spec existed.
 */
describe('StreamViewerComponent — header annotations', () => {
  let fixture: ComponentFixture<StreamViewerComponent>;
  let http: HttpTestingController;
  let socket: WebSocketServiceStub;

  const host = () => fixture.nativeElement as HTMLElement;

  /** Seeds the view through the component's own initial load. */
  const load = (messages: { id: string; fields: Record<string, string> }[]) =>
    http.expectOne(r => r.url.includes('/messages'))
      .flush({ success: true, count: messages.length, messages });

  beforeEach(async () => {
    socket = new WebSocketServiceStub();
    await TestBed.configureTestingModule({
      imports: [StreamViewerComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: WebSocketService, useValue: socket }
      ]
    }).compileComponents();

    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(StreamViewerComponent);
    // No consumer group on purpose: PEL enrichment is a separate concern and issues its own request.
    fixture.componentRef.setInput('stream', 'test-stream');
    fixture.autoDetectChanges(true);
    await settle();
  });

  const origin = () => host().querySelector('.badge.dlq-origin');

  it('does not mistake a business "reason" field for a dead-letter marker', async () => {
    load([{ id: '1-0', fields: { type: 'order.cancelled', order_id: '3254', reason: 'customer_request' } }]);
    await settle();

    expect(host().textContent).toContain('customer_request');  // still shown as a payload field
    expect(origin()).toBeNull();                               // but the entry is not dead-lettered
  });

  it('names the scenario in the header, short, with the mechanism on hover', async () => {
    load([{
      id: '5-0',
      fields: {
        type: 'order.created', reason: 'max deliveries (2) reached',
        originalId: '9-0', failedVia: 'NO_ACK,NO_ACK'
      }
    }]);
    await settle();

    // Short on purpose: we are looking at a DLQ, so "fail" is a given.
    expect(origin()!.textContent).toContain('Timeout ×2');
    expect(origin()!.textContent).not.toContain('Process &');
    expect(origin()!.getAttribute('title')).toContain('max deliveries (2) reached');
    expect(origin()!.getAttribute('title')).toContain('9-0');
  });

  it('renders every field of a swept entry, bookkeeping included', async () => {
    // The viewer shows what the stream holds; the header badge summarises it, it does not replace it.
    // The card is sized for this (see the DLQ viewer's messageHeight) rather than hiding rows.
    load([{
      id: '8-0',
      fields: {
        type: 'order.created', order_id: '777', reason: 'max deliveries (2) reached',
        originalId: '9-0', failedVia: 'NO_ACK,NO_ACK'
      }
    }]);
    await settle();

    const rows = Array.from(host().querySelectorAll('.field-row .field-key')).map(e => e.textContent);
    expect(rows).toEqual(['type', 'order_id', 'reason', 'originalId', 'failedVia']);
  });

  it('counts the hidden entries from what is actually on screen', async () => {
    // The label used to subtract `pageSize`, which is only right while the list happens to be full.
    // Drop a row (a trim, via MESSAGE_DELETED) and the two diverge: 4 held, 2 shown, so 2 are hidden —
    // not 1.
    fixture.componentRef.setInput('pageSize', 3);
    load([
      { id: '1-0', fields: { n: '1' } },
      { id: '2-0', fields: { n: '2' } },
      { id: '3-0', fields: { n: '3' } }
    ]);
    await settle();

    for (const id of ['4-0', '5-0']) {
      socket.events.next({
        eventType: 'MESSAGE_PRODUCED', messageId: id, streamName: 'test-stream', payload: { n: id }
      });
    }
    await settle();
    socket.events.next({ eventType: 'MESSAGE_DELETED', messageId: '5-0', streamName: 'test-stream' });
    await settle();

    const label = host().querySelector('.more-messages')!.textContent ?? '';
    expect(label).toContain('2 older');
  });

  it('says the hidden entries are the oldest, and are processed first', async () => {
    // The whole confusion this replaces: the window shows the NEWEST pageSize entries while the
    // consumer group hands out the OLDEST first, so the next message to be processed is off-screen and
    // a click appears to do nothing.
    fixture.componentRef.setInput('pageSize', 1);
    load([{ id: '1-0', fields: { n: '1' } }]);
    await settle();

    socket.events.next({
      eventType: 'MESSAGE_PRODUCED', messageId: '2-0', streamName: 'test-stream', payload: { n: '2' }
    });
    await settle();

    const label = host().querySelector('.more-messages')!;
    expect(label.textContent).toContain('processed first');
  });

  it('dims a failed message too, not just a successful one', async () => {
    load([{ id: '11-0', fields: { type: 'order.created', order_id: '1' } }]);
    await settle();

    socket.events.next({
      eventType: 'MESSAGE_RECLAIMED', messageId: '11-0',
      streamName: 'test-stream', failureKind: 'TIMEOUT'
    });
    await settle();

    // Success or failure, the row is behind us — that is what shows progress down the stream.
    expect(host().querySelector('.message-cell.handled')).not.toBeNull();
  });

  it('spells out a mixed run instead of pretending one button did it', async () => {
    load([{
      id: '6-0',
      fields: {
        type: 'order.created', reason: 'max deliveries (2) reached',
        originalId: '9-0', failedVia: 'NO_ACK,NACK_FAIL'
      }
    }]);
    await settle();

    expect(origin()!.textContent).toContain('Timeout → Explicit fail');
  });

  it('still marks an entry swept without a recorded scenario', async () => {
    // ARGV[6] is optional — five other services call the same Lua function without it, so the badge
    // has to name the fact when it cannot name the scenario.
    load([{
      id: '7-0',
      fields: { type: 'order.created', reason: 'max deliveries (2) reached', originalId: '9-0' }
    }]);
    await settle();

    expect(origin()!.textContent).toContain('Dead-lettered');
    expect(origin()!.getAttribute('title')).toContain('max deliveries (2) reached');
  });

  it('greys out a message that has just been processed, so progress is visible', async () => {
    load([{ id: '9-0', fields: { type: 'order.created', order_id: '1' } }]);
    await settle();

    socket.events.next({
      eventType: 'MESSAGE_PROCESSED', messageId: '9-0', streamName: 'test-stream'
    });
    await settle();

    expect(host().querySelector('.message-item.acked, .acked')).not.toBeNull();
    expect(host().querySelector('.badge.acked')).not.toBeNull();
  });

  it('badges the row with the kind of failure the last attempt suffered', async () => {
    load([{ id: '3-0', fields: { type: 'order.created', order_id: '1' } }]);
    await settle();

    socket.events.next({
      eventType: 'MESSAGE_RECLAIMED', messageId: '3-0',
      streamName: 'test-stream', failureKind: 'TIMEOUT'
    });
    await settle();

    expect(host().querySelector('.badge.failure')?.textContent).toContain('timeout');
  });

  it('does not double-badge a poisoned entry, which the delivery counter already reports', async () => {
    load([{ id: '4-0', fields: { type: 'order.created', order_id: '2' } }]);
    await settle();

    socket.events.next({
      eventType: 'MESSAGE_NACKED', messageId: '4-0',
      streamName: 'test-stream', failureKind: 'POISON'
    });
    await settle();

    expect(host().querySelector('.badge.failure')).toBeNull();
  });
});

/**
 * The pending-info poll only runs when a consumer group is set, so the race below needs its own setup.
 */
describe('StreamViewerComponent — acknowledged entries and the pending poll', () => {
  let fixture: ComponentFixture<StreamViewerComponent>;
  let http: HttpTestingController;
  let socket: WebSocketServiceStub;

  const host = () => fixture.nativeElement as HTMLElement;
  const flushPending = (messages: { id: string; deliveryCount: number; consumer: string }[]) =>
    http.match(r => r.url.includes('/pending-messages'))
      .forEach(r => r.flush({ success: true, messages }));

  beforeEach(async () => {
    socket = new WebSocketServiceStub();
    await TestBed.configureTestingModule({
      imports: [StreamViewerComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: WebSocketService, useValue: socket }
      ]
    }).compileComponents();

    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(StreamViewerComponent);
    fixture.componentRef.setInput('stream', 'test-stream');
    fixture.componentRef.setInput('group', 'test-group');
    fixture.autoDetectChanges(true);
    await settle();

    http.expectOne(r => r.url.includes('/messages') && !r.url.includes('pending'))
      .flush({ success: true, count: 1, messages: [{ id: '10-0', fields: { type: 'order.created' } }] });
    await settle();
    flushPending([]);
    await settle();
  });

  it('never shows a pending delivery count on an acknowledged entry', async () => {
    // The success path broadcasts BEFORE the XACK lands, so a poll in flight can still read the old
    // pending row. Observed in a browser as a "2×" delivery badge sitting next to "acked" on the same
    // card — two statements that cannot both be true.
    socket.events.next({
      eventType: 'MESSAGE_PROCESSED', messageId: '10-0', streamName: 'test-stream'
    });
    await settle();
    expect(host().querySelector('.badge.acked')).not.toBeNull();

    // Force another poll (this event's handler triggers one) and answer it with the stale row.
    socket.events.next({
      eventType: 'MESSAGE_RECLAIMED', messageId: 'not-on-screen', streamName: 'test-stream'
    });
    await settle();
    flushPending([{ id: '10-0', deliveryCount: 2, consumer: 'consumer-1' }]);
    await settle();

    expect(host().querySelector('.badge.acked')).not.toBeNull();
    expect(host().querySelector('.badge.deliveries')).toBeNull();
  });
});
