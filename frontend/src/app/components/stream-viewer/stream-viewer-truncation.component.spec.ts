import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { StreamViewerComponent } from './stream-viewer.component';
import { WebSocketService } from '../../services/websocket.service';
import { WebSocketServiceStub } from '../../testing/websocket.stub';
import { settle } from '../../testing/change-detection';

/**
 * A truncated window must announce itself on load, not only once a live event pushes a row off the
 * bottom.
 *
 * Observed on `/per-key-serialized`: 10 jobs submitted, the incoming viewer runs at `pageSize=5`, and
 * the footer read "5 of 5 messages" with no "older entries" line — so the five oldest, which are
 * exactly the ones the consumer group processes first, were both invisible and unaccounted for. The
 * endpoint's `count` is the size of the page, so it can never reveal that the page was truncated;
 * `streamLength` is the stream's own XLEN.
 */
describe('StreamViewerComponent — truncation is visible on load', () => {
  let fixture: ComponentFixture<StreamViewerComponent>;
  let http: HttpTestingController;
  let socket: WebSocketServiceStub;

  const host = () => fixture.nativeElement as HTMLElement;

  /** Seeds the view through the component's own initial load. */
  const load = (pageSize: number, streamLength: number) => {
    const messages = Array.from({ length: pageSize }, (_, i) => ({
      id: `${streamLength - i}-0`, fields: { type: 'order.created' }
    }));
    http.expectOne(r => r.url.includes('/messages'))
      .flush({ success: true, count: messages.length, streamLength, messages });
  };

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
    fixture.componentRef.setInput('stream', 'jobs.perkey.v1');
    fixture.componentRef.setInput('pageSize', 5);
    fixture.autoDetectChanges(true);
    await settle();
  });

  it('counts the footer against the stream, not against the page', async () => {
    load(5, 11);
    await settle();

    expect(host().querySelector('.message-count')!.textContent).toContain('5 of 11 messages');
  });

  it('shows the older-entries line, with how many are hidden', async () => {
    load(5, 11);
    await settle();

    const more = host().querySelector('.more-messages');
    expect(more).not.toBeNull();
    expect(more!.textContent).toContain('6 older entries not shown');
  });

  it('stays silent when the window holds the whole stream', async () => {
    load(3, 3);
    await settle();

    expect(host().querySelector('.more-messages')).toBeNull();
    expect(host().querySelector('.message-count')!.textContent).toContain('3 of 3 messages');
  });

  it('falls back to the page size when the backend omits streamLength', async () => {
    // An older backend, or the burst-produce response: no streamLength field. Reporting the page as
    // the whole stream is wrong but harmless; inventing a larger number would not be.
    const messages = [{ id: '1-0', fields: { type: 'order.created' } }];
    http.expectOne(r => r.url.includes('/messages'))
      .flush({ success: true, count: 1, messages });
    await settle();

    expect(host().querySelector('.message-count')!.textContent).toContain('1 of 1 messages');
    expect(host().querySelector('.more-messages')).toBeNull();
  });
});
