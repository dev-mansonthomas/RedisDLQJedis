import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DlqActionsComponent } from './dlq-actions.component';
import { settle } from '../../testing/change-detection';

/**
 * Behavioural spec for the status banner and the button lockout, driven by HTTP responses.
 *
 * **Deliberately not labelled an OnPush guard, because it cannot be one — measured, not assumed.**
 * Turning `statusMessage` into a plain field (the exact regression the WebSocket specs catch) leaves
 * these cases green: the same response callback also writes `isProcessing` and `isError`, which *are*
 * signals, so the view is marked dirty anyway and the plain field is repainted along for the ride.
 *
 * That is worth knowing beyond this file. An OnPush repaint regression is only observable when no
 * other signal is written in the same turn — which makes it rarer, but also sneakier, and means the
 * guards that earn their keep are the ones on views whose repaint hangs on a single signal:
 * `pubsub-subscriber` (its `messages` list) and `llm-chat` (its `live` token buffer).
 */
describe('DlqActionsComponent — status banner and button lockout', () => {
  const API = 'http://localhost:8080/api/dlq';

  let fixture: ComponentFixture<DlqActionsComponent>;
  let http: HttpTestingController;

  const text = async () => {
    await settle();
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DlqActionsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()]
    }).compileComponents();

    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(DlqActionsComponent);
    fixture.autoDetectChanges(true);
    await settle();
  });

  afterEach(() => {
    // Timers fired by the component's 3s banner reset can leave requests unflushed; only assert on
    // what each test explicitly expects.
    http.verify({ ignoreCancelled: true });
  });

  it('renders no banner before any action', async () => {
    expect(await text()).not.toContain('Processing...');
  });

  it('paints the success message returned by the backend', async () => {
    fixture.componentInstance.process('ACK');

    expect(await text()).toContain('Processing...');

    http.expectOne(`${API}/process`).flush({ success: true, message: 'Message ACKed' });

    expect(await text()).toContain('Message ACKed');
  });

  it('paints the backend message when there was nothing to process', async () => {
    fixture.componentInstance.process('ACK');
    http.expectOne(`${API}/process`).flush({ success: false, message: 'No messages to process' });

    const rendered = await text();
    expect(rendered).toContain('No messages to process');
    expect((fixture.nativeElement as HTMLElement).querySelector('.status-message.error')).not.toBeNull();
  });

  it('paints a failing outcome in red even though the REST call succeeded', async () => {
    // The regression this pins: `Process & Fail` returns success:true — the call worked, the message
    // did not — and colouring by that flag alone printed "processing failed" in a green box.
    fixture.componentInstance.process('NO_ACK');
    http.expectOne(`${API}/process`).flush({
      success: true, message: '✗ Message 1-0 processing failed (will retry, deliveryCount: 1)'
    });

    await settle();
    expect((fixture.nativeElement as HTMLElement).querySelector('.status-message.error')).not.toBeNull();
  });

  it('leaves a graceful release green — nothing failed, the budget was refunded', async () => {
    fixture.componentInstance.process('NACK_SILENT');
    http.expectOne(`${API}/process`).flush({ success: true, message: '↩ Message 1-0 released (SILENT)' });

    await settle();
    expect((fixture.nativeElement as HTMLElement).querySelector('.status-message.error')).toBeNull();
  });

  it('replaces the previous status rather than stacking', async () => {
    // Duration is deliberately NOT asserted here: `vi.useFakeTimers()` freezes Angular's scheduler,
    // so the DOM would go stale and every case would fail for the wrong reason (documented trap).
    // The 10s window was measured in a browser instead.
    fixture.componentInstance.process('ACK');
    http.expectOne(`${API}/process`).flush({ success: true, message: 'first' });
    expect(await text()).toContain('first');

    fixture.componentInstance.process('NO_ACK');
    http.expectOne(`${API}/process`).flush({ success: true, message: 'second' });

    const rendered = await text();
    expect(rendered).toContain('second');
    expect(rendered).not.toContain('first');
  });

  it('asks before clearing, and deletes nothing until the dialog is confirmed', async () => {
    fixture.componentInstance.clearAllStreams();
    await settle();

    // The whole point of dropping the native confirm(): the request must not have been sent yet.
    http.expectNone(`${API}/stream/test-stream`);
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="dialog"]')).not.toBeNull();

    fixture.componentInstance.confirmClear();
    await settle();

    http.expectOne(`${API}/stream/test-stream`).flush(null);
    http.expectOne(`${API}/stream/test-stream:dlq`).flush(null);
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="dialog"]')).toBeNull();
  });

  it('re-enables the buttons once the response lands', async () => {
    const buttons = () => Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button'));

    fixture.componentInstance.process('NO_ACK');
    await settle();
    expect(buttons().every(b => b.disabled)).toBe(true);

    http.expectOne(`${API}/process`).flush({ success: true, message: 'done' });
    await settle();

    expect(buttons().some(b => !b.disabled)).toBe(true);
  });
});
