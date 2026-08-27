import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { PerKeySerializedComponent } from './per-key-serialized.component';
import { WebSocketService } from '../../services/websocket.service';
import { WebSocketServiceStub } from '../../testing/websocket.stub';
import { UNKNOWN_KEY_COLOR, keyColor } from '../../services/key-color';
import { settle } from '../../testing/change-detection';

/**
 * Guards for the submitted batch itself, which is the demo's input and therefore what every other
 * panel on the page is showing.
 *
 * The palette invariant is the one worth a test: `keyColor` knows six keys and falls back to slate for
 * anything else, so a seventh business key would put two indistinguishable grey blocks in the
 * time-slot grid and quietly destroy the thing the grid exists to show.
 */
describe('PerKeySerializedComponent — the submitted batch', () => {
  let fixture: ComponentFixture<PerKeySerializedComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PerKeySerializedComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: WebSocketService, useValue: new WebSocketServiceStub() }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(PerKeySerializedComponent);
    fixture.autoDetectChanges(true);
    await settle();
    // ngOnInit clears the demo streams; the response is irrelevant here.
    TestBed.inject(HttpTestingController).match(() => true).forEach(r => r.flush({ success: true }));
  });

  it('every key in the batch has its own colour — none falls back to slate', () => {
    const greys = fixture.componentInstance.jobs()
      .filter(j => keyColor(j.orderId) === UNKNOWN_KEY_COLOR);

    expect(greys).toEqual([]);
  });

  it('uses at most the six keys the palette can distinguish', () => {
    const keys = new Set(fixture.componentInstance.jobs().map(j => j.orderId));

    expect(keys.size).toBeLessThanOrEqual(6);
  });

  it('sends a batch big enough to fill the grid, with one key chained long enough to serialize', () => {
    const jobs = fixture.componentInstance.jobs();
    const perKey = new Map<string, number>();
    jobs.forEach(j => perKey.set(j.orderId, (perKey.get(j.orderId) ?? 0) + 1));

    expect(jobs.length).toBeGreaterThanOrEqual(24);
    // One key must carry a long chain, or nothing visibly serializes.
    expect(Math.max(...perKey.values())).toBeGreaterThanOrEqual(7);
    expect(jobs.every(j => j.selected)).toBe(true);
  });

  it('renders every job in a list that scrolls instead of stretching the page', () => {
    const host = fixture.nativeElement as HTMLElement;
    const list = host.querySelector('.jobs-list')!;

    expect(list.querySelectorAll('.job-item')).toHaveLength(fixture.componentInstance.jobs().length);
    // The Submit button must stay reachable without scrolling the whole page, so the list itself is
    // the scroll container.
    expect(getComputedStyle(list).overflowY).toBe('auto');
  });
});
