import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal }
  from '@angular/core';
import { Subscription } from 'rxjs';

import { PerKeySlotEvent, StreamEvent, WebSocketService } from '../../services/websocket.service';
import { keyColor } from '../../services/key-color';
import { buildGrid, Run, Skip, SLOT_MS } from './slot-model';

/** Workers the service runs (`PerKeySerializedService.NUM_WORKERS`). */
const WORKERS = 3;

/** `PerKeySerializedService.LOCK_TTL_MS` — how long an abandoned run can still hold a key. */
const LOCK_TTL_MS = 30_000;

@Component({
  selector: 'app-per-key-lanes',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="lanes">
      <header class="lanes-header">
        <h3 class="lanes-title">⏱ Time slots — one row per second, one column per worker</h3>
        <span class="overlap-count" [class.bad]="grid().overlapCount > 0">{{ grid().overlapCount }} {{ grid().overlapCount === 1 ? 'overlap' : 'overlaps' }}</span>
      </header>

      @if (grid().rows.length === 0) {
        <p class="empty">Submit jobs to watch the workers fill the slots.</p>
      } @else {
        <div class="grid-head">
          <span class="slot-label"></span>
          @for (worker of workers; track worker) {
            <span class="worker-label">worker-{{ worker }}</span>
          }
        </div>

        @for (row of grid().rows; track row.slot) {
          <div class="lane-row" [class.violating]="row.violating">
            <span class="slot-label">t+{{ row.slot }}s</span>
            @for (cell of row.cells; track $index) {
              <span class="lane-cell"
                    [attr.data-worker]="$index + 1"
                    [attr.data-key]="cell.key"
                    [class.running]="cell.running"
                    [class.violating]="cell.violating"
                    [style.background-color]="cell.key ? keyColor(cell.key) : ''"
                    [title]="cell.key ? cell.key + ' — ' + cell.action : ''">
                @if (cell.key) {
                  <span class="cell-key">{{ cell.key }}</span>
                }
                @if (cell.endUnknown) {
                  <span class="unknown" title="No FINISHED seen; the lock TTL has expired">?</span>
                }
                @for (skip of cell.skips; track $index) {
                  <span class="skip-marker"
                        [title]="'worker was refused ' + skip + ' — another worker held it'">⊘</span>
                }
              </span>
            }
          </div>
        }
      }
    </section>
    `,
  styles: [`
    .lanes { background: white; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }
    .lanes-header {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 10px 14px; border-bottom: 1px solid #e2e8f0;
      background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
    }
    .lanes-title { margin: 0; font-size: 14px; font-weight: 600; color: #1e293b; }
    .overlap-count {
      padding: 2px 8px; border-radius: 10px; background: #dcfce7; color: #166534;
      font-size: 11px; font-weight: 700; white-space: nowrap;
    }
    .overlap-count.bad { background: #fee2e2; color: #991b1b; }
    .empty { margin: 0; padding: 16px; font-size: 13px; color: #64748b; }
    .grid-head, .lane-row {
      display: grid; grid-template-columns: 56px repeat(3, minmax(0, 1fr));
      gap: 2px; padding: 0 8px;
    }
    .grid-head { padding-top: 8px; padding-bottom: 4px; }
    .worker-label, .slot-label {
      font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase;
    }
    .lane-row { align-items: stretch; }
    .lane-row:last-child { padding-bottom: 8px; }
    .lane-row.violating { outline: 2px solid #dc2626; outline-offset: -1px; border-radius: 3px; }
    .slot-label { display: flex; align-items: center; font-family: 'Courier New', monospace; }
    .lane-cell {
      display: flex; align-items: center; gap: 4px; min-height: 20px; padding: 1px 6px;
      border-radius: 3px; background: #f8fafc; color: white;
      font-size: 10px; font-weight: 700;
    }
    .lane-cell.running { box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.6); }
    .lane-cell.violating { outline: 2px solid #dc2626; }
    .cell-key { text-shadow: 0 1px 1px rgba(0, 0, 0, 0.35); }
    .skip-marker { color: #b91c1c; background: #fee2e2; border-radius: 2px; padding: 0 3px; }
    .unknown { color: #fef3c7; }
  `]
})
export class PerKeyLanesComponent implements OnInit, OnDestroy {
  private readonly ws = inject(WebSocketService);
  private subscription?: Subscription;
  private tick?: ReturnType<typeof setInterval>;

  readonly workers = Array.from({ length: WORKERS }, (_, i) => i + 1);
  readonly keyColor = keyColor;

  /**
   * State is replaced wholesale on every update, never mutated: an OnPush view reading a mutated
   * object never repaints, which is the regression this codebase has already paid for once.
   */
  private readonly runs = signal<Run[]>([]);
  private readonly skips = signal<Skip[]>([]);
  private readonly anchorMs = signal<number | null>(null);

  /**
   * Backend clock, corrected once. `atMs` comes from the backend container and `Date.now()` from the
   * host — comparing them raw would drift. The tick below advances this so a running job grows.
   */
  private readonly clockOffsetMs = signal(0);
  private readonly nowMs = signal(0);

  readonly grid = computed(() => {
    const anchor = this.anchorMs();
    if (anchor === null) return { rows: [], overlapCount: 0 };
    return buildGrid(this.runs(), this.skips(), anchor, this.nowMs(), WORKERS, LOCK_TTL_MS);
  });

  ngOnInit(): void {
    this.subscription = this.ws.getEvents().subscribe((event: StreamEvent) => {
      if (event.eventType !== 'PER_KEY_SLOT') return;
      this.absorb(event as PerKeySlotEvent);
    });
    this.tick = setInterval(() => {
      if (this.anchorMs() !== null) this.nowMs.set(Date.now() + this.clockOffsetMs());
    }, SLOT_MS);
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    if (this.tick !== undefined) clearInterval(this.tick);
  }

  private absorb(event: PerKeySlotEvent): void {
    if (this.anchorMs() === null) {
      this.anchorMs.set(event.atMs);
      this.clockOffsetMs.set(event.atMs - Date.now());
    }
    this.nowMs.set(Math.max(this.nowMs(), event.atMs));

    if (event.phase === 'LOCK_SKIPPED') {
      this.skips.set([...this.skips(),
        { workerId: event.workerId, key: event.orderId, atMs: event.atMs }]);
      return;
    }

    const existing = this.runs().find(r => r.messageId === event.messageId);
    if (existing) {
      // A FINISHED closing a run we already know, or a STARTED for one we only saw finish.
      this.runs.set(this.runs().map(r => r.messageId !== event.messageId ? r : {
        ...r,
        startMs: event.phase === 'STARTED' ? event.atMs : r.startMs,
        endMs: event.phase === 'FINISHED' ? event.atMs : r.endMs
      }));
      return;
    }

    this.runs.set([...this.runs(), {
      messageId: event.messageId,
      workerId: event.workerId,
      key: event.orderId,
      action: event.action,
      // A FINISHED with no STARTED means the page opened mid-run: keep it, with an unknown start.
      startMs: event.phase === 'STARTED' ? event.atMs : null,
      endMs: event.phase === 'FINISHED' ? event.atMs : null
    }]);
  }
}
