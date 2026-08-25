import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialogComponent } from './confirm-dialog.component';
import { settle } from '../../testing/change-detection';

/**
 * Guard for the in-house confirmation dialog that replaced the native `confirm()`.
 *
 * The native dialog was unstyleable, untestable and blocked the whole tab; the replacement has to earn
 * that back — which means the keyboard path and the dialog semantics are part of the contract, not
 * decoration.
 */
describe('ConfirmDialogComponent', () => {
  let fixture: ComponentFixture<ConfirmDialogComponent>;

  const host = () => fixture.nativeElement as HTMLElement;
  const button = (cls: string) => host().querySelector<HTMLButtonElement>(`button.${cls}`)!;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ConfirmDialogComponent] }).compileComponents();
    fixture = TestBed.createComponent(ConfirmDialogComponent);
    fixture.componentRef.setInput('title', 'Clear all streams?');
    fixture.componentRef.setInput('message', 'This deletes test-stream and test-stream:dlq.');
    fixture.componentRef.setInput('detail', 'Consumer groups are recreated on the next action.');
    fixture.componentRef.setInput('confirmLabel', 'Clear all');
    fixture.autoDetectChanges(true);
    await settle();
  });

  it('renders the question, the consequence and the detail', () => {
    const rendered = host().textContent ?? '';
    expect(rendered).toContain('Clear all streams?');
    expect(rendered).toContain('This deletes test-stream and test-stream:dlq.');
    expect(rendered).toContain('Consumer groups are recreated on the next action.');
  });

  it('carries dialog semantics an assistive technology can use', () => {
    const dialog = host().querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    // The accessible name must come from the title, not from a guess.
    const labelledBy = dialog!.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(host().querySelector(`#${labelledBy}`)?.textContent).toContain('Clear all streams?');
  });

  it('emits confirmed when the destructive button is pressed', async () => {
    const confirmed = vi.fn();
    fixture.componentInstance.confirmed.subscribe(confirmed);

    button('confirm').click();
    await settle();

    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('emits cancelled when the cancel button is pressed', async () => {
    const cancelled = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancelled);

    button('cancel').click();
    await settle();

    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape, so the keyboard is never trapped', async () => {
    const cancelled = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancelled);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();

    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('opens with the cancel button focused — a destructive action must not be one Enter away', async () => {
    await settle();
    expect(document.activeElement).toBe(button('cancel'));
  });

  it('uses the caller-supplied confirm label', () => {
    expect(button('confirm').textContent).toContain('Clear all');
  });
});
