import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal }
  from '@angular/core';
import { Subscription } from 'rxjs';

import { PerKeySlotEvent, StreamEvent, WebSocketService } from '../../services/websocket.service';
import { keyColor } from '../../services/key-color';
import { buildGrid, stamp, Run, Skip, SLOT_MS } from './slot-model';

/** Workers the service runs (`PerKeySerializedService.NUM_WORKERS`). */
const WORKERS = 3;

/** `PerKeySerializedService.LOCK_TTL_MS` — how long an abandoned run can still hold a key. */
const LOCK_TTL_MS = 30_000;

/**
 * The per-worker done streams, named exactly as Redis holds them
 * (`PerKeySerializedService.WORKER_DONE_PREFIX`).
 *
 * This grid replaced the three stream viewers that used to sit here, so it carries what their headers
 * carried: a column labelled "worker-2" leaves a reader unable to match it against RedisInsight or a
 * `redis-cli XRANGE`.
 */
const DONE_STREAM_PREFIX = 'jobs.perkey.v1.worker';
const DONE_STREAM_SUFFIX = '.done';

@Component({
  selector: 'app-per-key-lanes',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="lanes" [attr.data-clock]="inFlight() ? 'running' : 'stopped'">
      <header class="lanes-header">
        <h3 class="lanes-title">⏱ Time slots — one row per second, one column per worker</h3>
        <span class="clock-state" [class.live]="inFlight()">{{ inFlight() ? '▶ live' : '⏸ stopped' }}</span>
        <span class="overlap-count" [class.bad]="grid().overlapCount > 0">{{ grid().overlapCount }} {{ grid().overlapCount === 1 ? 'overlap' : 'overlaps' }}</span>
      </header>

      <div class="grid-head">
        <span class="slot-label"></span>
        @for (worker of workers; track worker) {
          <span class="worker-head">
            <span class="worker-stream">{{ doneStream(worker) }}</span>
            <span class="worker-status"
                  [class.connected]="connected()"
                  [class.disconnected]="!connected()">
              <span class="status-dot"></span>{{ connected() ? 'Connected' : 'Disconnected' }}
            </span>
          </span>
        }
      </div>

      @if (grid().rows.length === 0) {
        <p class="empty">Submit jobs to watch the workers fill the slots.</p>
      } @else {
        <div class="lane-body">
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
                @if (cell.action) {
                  <span class="cell-action">{{ cell.action }}</span>
                }
                @if (cell.startedAtMs !== null) {
                  <span class="stamp stamp-start"
                        title="This job started at this instant (mm:ss.SSS)">▸{{ stamp(cell.startedAtMs) }}</span>
                }
                @if (cell.endedAtMs !== null) {
                  <span class="stamp stamp-end"
                        title="This job finished at this instant (mm:ss.SSS)">▪{{ stamp(cell.endedAtMs) }}</span>
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
        </div>
      }

      <!-- Both facts below were asked about by a reader of the real page, and measured in the backend
           log before being written here: 33 runs showed zero refusals logged while that worker was
           mid-run, and one worker produced up to 3 refusals inside a single second. -->
      <footer class="lanes-legend">
        <span class="legend-mark">⊘</span>

        <p class="legend-text">
          <strong>One refused attempt.</strong> A worker read a job, found its key already held by
          another worker, and moved on rather than waiting — the job stays pending and comes back via
          <code>XAUTOCLAIM</code> about a second later. This refusal <em>is</em> the guarantee doing
          its work.
        </p>
        <p class="legend-text">
          <strong>Count per attempt, not per worker.</strong> One worker can be refused several times
          in the same second — it polls twice a second and each poll can be turned away — so a row
          may hold more markers than there are workers.
        </p>
        <p class="legend-text">
          <strong>▸ start and ▪ end (mm:ss.SSS).</strong> Two cells of the same colour in one row are
          a <em>hand-off</em>, not an overlap, whenever the ▪ end above precedes the ▸ start beside it
          — one second of grid is far coarser than the jobs it holds. The
          <code>overlaps</code> counter judges the real intervals, never the row.
        </p>
        <p class="legend-text">
          <strong>On a coloured cell, it sits at a job boundary.</strong> A worker cannot be refused
          while it is processing, since it is asleep for the whole job. A marker on a busy cell means
          the worker finished that job, was refused, and picked up the next one — all inside the same
          second.
        </p>
      </footer>
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
    .grid-head {
      padding-top: 8px; padding-bottom: 6px; align-items: end;
      border-bottom: 1px solid #e2e8f0;
    }
    .slot-label {
      font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase;
    }
    /* Two lines on purpose: the stream name is 27 characters and must stay readable in full. */
    .worker-head { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .worker-stream {
      font-family: 'Courier New', monospace; font-size: 11px; font-weight: 700; color: #1e293b;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* Same pill as every stream viewer's header (.connection-status): this grid replaced three of
       them, so the state a reader looks for must not change shape on the way.
       No backticks in here — this block is a template literal, and one would end it early. */
    .worker-status {
      display: inline-flex; align-items: center; align-self: flex-start; gap: 4px;
      padding: 3px 8px; border-radius: 10px; background: #f1f5f9;
      font-size: 11px; font-weight: 500;
    }
    .worker-status.connected { background: #dcfce7; color: #166534; }
    .worker-status.disconnected { background: #fee2e2; color: #991b1b; }
    .status-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
    .lanes-legend {
      display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; align-items: start;
      padding: 10px 14px; border-top: 1px solid #e2e8f0; background: #f8fafc;
    }
    .legend-mark {
      grid-row: 1 / span 4; align-self: center;
      color: #b91c1c; background: #fee2e2; border-radius: 3px; padding: 2px 6px;
      font-size: 14px; font-weight: 700;
    }
    .legend-text { margin: 0; font-size: 12px; line-height: 1.45; color: #475569; }
    .legend-text strong { color: #1e293b; }
    .legend-text code {
      font-family: 'Courier New', monospace; font-size: 11px;
      background: #e2e8f0; border-radius: 3px; padding: 0 4px;
    }
    /* The grid took the viewers' slot in the layout, so it takes their bounded height too: at
       MAX_SLOTS the body would otherwise be 120 rows tall and push the page around. */
    .lane-body { max-height: 840px; overflow-y: auto; padding-top: 4px; }
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
    /* Pushed to the right so a column of stamps lines up and can be read down the page. */
    .stamp {
      margin-left: auto; padding: 0 4px; border-radius: 3px;
      background: rgba(255, 255, 255, 0.25); color: white;
      font-family: 'Courier New', monospace; font-size: 10px; font-weight: 700;
      white-space: nowrap;
    }
    .stamp-end { background: rgba(0, 0, 0, 0.28); }
    .stamp + .stamp { margin-left: 4px; }
    /* The action is the *what*, the colour is the *which key*: a row saying only "#1001" four times
       tells a viewer nothing about the work being serialized. Lighter than the key so the eye still
       lands on the colour block first. */
    .cell-action {
      font-weight: 500; opacity: 0.85; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; text-shadow: 0 1px 1px rgba(0, 0, 0, 0.35);
    }
    .clock-state {
      padding: 2px 8px; border-radius: 10px; background: #e2e8f0; color: #475569;
      font-size: 11px; font-weight: 700; white-space: nowrap;
    }
    .clock-state.live { background: #dbeafe; color: #1d4ed8; }
    .skip-marker { color: #b91c1c; background: #fee2e2; border-radius: 2px; padding: 0 3px; }
    .unknown { color: #fef3c7; }
  `]
})
export class PerKeyLanesComponent implements OnInit, OnDestroy {
  private readonly ws = inject(WebSocketService);
  private subscription?: Subscription;
  private statusSubscription?: Subscription;
  private tick?: ReturnType<typeof setInterval>;

  readonly workers = Array.from({ length: WORKERS }, (_, i) => i + 1);
  readonly keyColor = keyColor;
  readonly stamp = stamp;

  /**
   * Socket state, shown once per column because that is where a reader looks for it.
   *
   * One socket serves the whole app, so the three indicators always agree — they are not three
   * independent connections, and this mirrors exactly what the three stream viewers displayed here
   * before the grid replaced them.
   */
  private readonly connectedState = signal(false);
  readonly connected = this.connectedState.asReadonly();

  doneStream(worker: number): string {
    return `${DONE_STREAM_PREFIX}${worker}${DONE_STREAM_SUFFIX}`;
  }

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

  /**
   * Whether the grid's clock should still be advancing.
   *
   * True only while a job is genuinely in flight: a run with no `FINISHED` whose lock has not yet
   * expired. Once the last job lands the clock freezes at that event, so a page left open after the
   * demo drains stops growing a row per second and the interesting slots stay on screen.
   *
   * The TTL bound matters as much as the `FINISHED`: a worker killed mid-job never reports finishing,
   * and without it that one run would keep the clock alive for the rest of the session.
   *
   * Consequence worth knowing: the clock also pauses in the gaps *between* same-key jobs, while the
   * backlog waits for `RECLAIM_MIN_IDLE_MS`. Nothing is lost — the next event carries its own `atMs`,
   * so those idle seconds are drawn when it arrives. They appear retroactively rather than live.
   */
  readonly inFlight = computed(() => {
    const now = this.nowMs();
    return this.runs().some(r =>
      r.endMs === null && r.startMs !== null && now < (r.startMs as number) + LOCK_TTL_MS);
  });

  readonly grid = computed(() => {
    const anchor = this.anchorMs();
    if (anchor === null) return { rows: [], overlapCount: 0 };
    return buildGrid(this.runs(), this.skips(), anchor, this.nowMs(), WORKERS, LOCK_TTL_MS);
  });

  ngOnInit(): void {
    this.statusSubscription = this.ws.getConnectionStatus()
      .subscribe(status => this.connectedState.set(status));
    this.subscription = this.ws.getEvents().subscribe((event: StreamEvent) => {
      if (event.eventType !== 'PER_KEY_SLOT') return;
      this.absorb(event as PerKeySlotEvent);
    });
    this.tick = setInterval(() => {
      // Only while something is actually running: see `inFlight`.
      if (this.anchorMs() !== null && this.inFlight()) {
        this.nowMs.set(Date.now() + this.clockOffsetMs());
      }
    }, SLOT_MS);
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.statusSubscription?.unsubscribe();
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
