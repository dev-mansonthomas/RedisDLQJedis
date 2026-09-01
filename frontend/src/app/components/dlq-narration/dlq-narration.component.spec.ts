import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DlqNarrationComponent } from './dlq-narration.component';
import { DlqScenarioService } from '../../services/dlq-scenario.service';
import { settle } from '../../testing/change-detection';
import { API_BASE } from '../../api.config';

/**
 * Guard for the narration panel — and a genuine `OnPush` guard, unlike `dlq-actions`.
 *
 * The panel's whole view derives from a single signal (`DlqScenarioService.progress`) plus the
 * fetched `maxDeliveries`. Nothing else is written in the same turn, so if a future change mutates
 * the progress object in place, or turns `maxDeliveries` into a plain field, the DOM assertions here
 * go red instead of being repainted for free by a co-located signal write.
 */
describe('DlqNarrationComponent', () => {
  const CONFIG_URL = `${API_BASE}/dlq/config?streamName=test-stream`;

  let fixture: ComponentFixture<DlqNarrationComponent>;
  let http: HttpTestingController;
  let scenarios: DlqScenarioService;

  const text = async () => {
    await settle();
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  };

  /** Resolves the config request the component issues on init. */
  const answerConfig = (maxDeliveries: number) =>
    http.expectOne(CONFIG_URL).flush({
      streamName: 'test-stream', dlqStreamName: 'test-stream:dlq', consumerGroup: 'test-group',
      consumerName: 'consumer-1', minIdleMs: 100, count: 100, maxDeliveries
    });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DlqNarrationComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()]
    }).compileComponents();

    http = TestBed.inject(HttpTestingController);
    scenarios = TestBed.inject(DlqScenarioService);
    fixture = TestBed.createComponent(DlqNarrationComponent);
    fixture.autoDetectChanges(true);
    await settle();
  });

  afterEach(() => http.verify({ ignoreCancelled: true }));

  it('stays out of the way until the operator clicks something', async () => {
    answerConfig(2);
    expect(await text()).toBe('');
  });

  it('narrates the crash-and-retry scenario once a timeout failure is clicked', async () => {
    answerConfig(2);
    scenarios.record('NO_ACK');

    const rendered = await text();
    expect(rendered).toContain('Consumer crash');
    expect(rendered).toContain('no message is lost');
  });

  it('counts the retry budget from the live configuration, not a hardcoded default', async () => {
    answerConfig(3);
    scenarios.record('NO_ACK');

    expect(await text()).toContain('1 of 3');

    scenarios.record('NO_ACK');
    scenarios.record('NO_ACK');

    expect(await text()).toContain('3 of 3');
  });

  it('makes the sweep the current step once the retry budget is spent', async () => {
    answerConfig(2);
    // The production step has to be satisfied first, otherwise "generate messages" is legitimately
    // still the current step — which the panel is right to say.
    scenarios.record('GENERATE');
    scenarios.record('NO_ACK');
    scenarios.record('NO_ACK');

    await settle();
    const current = (fixture.nativeElement as HTMLElement).querySelector('.step.current');
    expect(current?.textContent).toContain('once more');
  });

  it('warns that the sweeping click reports "no messages available"', async () => {
    // Measured on the running stack: with maxDeliveries=2 the third click returns success:false and
    // paints a red banner, while it is in fact the click that routes the message to the DLQ.
    answerConfig(2);
    scenarios.record('NO_ACK');

    expect(await text()).toContain('No messages available');
  });

  it('falls back to a retry budget of 2 when the configuration cannot be read', async () => {
    http.expectOne(CONFIG_URL).error(new ProgressEvent('network error'));
    scenarios.record('NO_ACK');

    expect(await text()).toContain('1 of 2');
  });

  it('qualifies the silent-release guarantee instead of overstating it', async () => {
    // Measured 2026-08-25: SILENT refunds its OWN delivery only. A Fail followed by a Release leaves
    // the counter at 1, so "never reaches the DLQ, however often you repeat this" was false as soon as
    // the operator mixed the two buttons. The claim now names its precondition.
    answerConfig(2);
    scenarios.record('NACK_SILENT');

    const rendered = await text();
    expect(rendered).toContain('pure release loop never reaches the DLQ');
    expect(rendered).toContain('does not wipe charges already on the clock');
  });

  it('closes when the streams are cleared', async () => {
    answerConfig(2);
    scenarios.record('ACK');
    expect(await text()).not.toBe('');

    scenarios.record('CLEAR');
    expect(await text()).toBe('');
  });
});
