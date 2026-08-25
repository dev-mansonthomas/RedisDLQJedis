import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { DlqScenarioService } from './dlq-scenario.service';

/**
 * The scenario tracker is pure state: which demo story the narration panel is telling, and how far
 * through it the operator has clicked. Every case here is derivable from clicks alone — no HTTP, no
 * Redis — which is why it is worth pinning precisely.
 */
describe('DlqScenarioService', () => {
  let service: DlqScenarioService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(DlqScenarioService);
  });

  it('starts with no active scenario', () => {
    expect(service.progress().activeAction).toBeNull();
    expect(service.progress().generated).toBe(0);
  });

  it('activates the generate scenario and counts productions', () => {
    service.record('GENERATE');
    expect(service.progress().activeAction).toBe('GENERATE');
    expect(service.progress().generated).toBe(1);

    service.record('GENERATE');
    expect(service.progress().generated).toBe(2);
  });

  it('activates an outcome scenario with a single click counted', () => {
    service.record('GENERATE');
    service.record('NO_ACK');

    expect(service.progress().activeAction).toBe('NO_ACK');
    expect(service.progress().counts['NO_ACK']).toBe(1);
    // The production step stays satisfied — the operator did generate messages.
    expect(service.progress().generated).toBe(1);
  });

  it('counts repeated clicks on the same outcome, which is what drives the retry budget', () => {
    service.record('NO_ACK');
    service.record('NO_ACK');
    service.record('NO_ACK');

    expect(service.progress().counts['NO_ACK']).toBe(3);
  });

  it('resets the count when the operator switches to a different outcome', () => {
    service.record('NO_ACK');
    service.record('NO_ACK');
    service.record('NACK_FATAL');

    expect(service.progress().activeAction).toBe('NACK_FATAL');
    expect(service.progress().counts['NACK_FATAL']).toBe(1);
    // The previous story is over; its half-finished retry count must not leak into the new one.
    expect(service.progress().counts['NO_ACK']).toBeUndefined();
  });

  it('treats a new production as the start of a fresh run', () => {
    service.record('NO_ACK');
    service.record('NO_ACK');
    service.record('GENERATE');

    expect(service.progress().activeAction).toBe('GENERATE');
    expect(service.progress().counts).toEqual({});
    // One production in this run, so one — the counter tracks productions, not clicks of any kind.
    expect(service.progress().generated).toBe(1);
  });

  it('clearing the streams clears the narration', () => {
    service.record('GENERATE');
    service.record('ACK');
    service.record('CLEAR');

    expect(service.progress().activeAction).toBeNull();
    expect(service.progress().generated).toBe(0);
    expect(service.progress().counts).toEqual({});
  });

  it('replaces the state object rather than mutating it', () => {
    // Not pedantry: an OnPush view reading this signal never repaints if the object is mutated in
    // place, which is the exact regression documented for this codebase.
    const before = service.progress();
    service.record('ACK');
    const after = service.progress();

    expect(after).not.toBe(before);
    expect(before.counts['ACK']).toBeUndefined();
  });
});
