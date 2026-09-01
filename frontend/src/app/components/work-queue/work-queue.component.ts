import { Component, OnInit, OnDestroy, inject, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Observable, Subscription } from 'rxjs';
import { StreamViewerComponent } from '../stream-viewer/stream-viewer.component';
import { StreamRefreshService } from '../../services/stream-refresh.service';
import { MermaidDiagramComponent } from '../mermaid-diagram/mermaid-diagram.component';
import { DiagramDefinitionsService } from '../../services/diagram-definitions.service';
import { WebSocketService, DLQEvent } from '../../services/websocket.service';
import { API_BASE } from '../../api.config';

interface SleepOption {
  label: string;
  value: number;
}

/** Stream names for this pattern — served by GET /api/work-queue/streams, never hard-coded here. */
interface WorkQueueStreams {
  jobStream: string;
  dlqStream: string;
  group: string;
  doneStreams: string[];
  /** Prefix of the per-worker done streams; the throughput counter matches completions on it. */
  doneStreamPrefix: string;
}

/** Worker-pool state: how many workers run, and the bounds they can move between. */
interface WorkerPool {
  count: number;
  min: number;
  max: number;
}

/** A worker as the backend describes it. */
interface WorkerDescriptor {
  id: number;
  name: string;
  doneStream: string;
}

/** Reply of POST/DELETE /workers. `error` is set on the 409 that a pool bound produces. */
interface WorkerMutationResponse {
  success: boolean;
  count: number;
  kill?: boolean;
  added?: WorkerDescriptor;
  removed?: WorkerDescriptor;
  note?: string;
  error?: string;
}

/**
 * One option of the "Demo mode" dropdown. The timings come from the backend (which owns them and
 * enforces `minIdleMs >= 2 * workMs`), so the label never drifts from what the workers actually do.
 */
interface DemoModeDescriptor {
  name: string;
  label: string;
  workMs: number;
  minIdleMs: number;
  pollMs: number;
  /** Advisory: the producer loop runs in this page, so we apply it to "Sleep between jobs". */
  producerSleepMs: number;
  /** How many jobs the Burst button queues in this mode. */
  burstSize: number;
}

/** Reply of POST /produce. */
interface ProduceResponse {
  success: boolean;
  jobId?: string;
  messageId?: string;
  error?: string;
}

/** Active demo mode (effective timings) plus the options to offer. */
interface DemoModeState {
  mode: string;
  label: string;
  workMs: number;
  minIdleMs: number;
  pollMs: number;
  producerSleepMs: number;
  burstSize: number;
  modes: DemoModeDescriptor[];
}

/** Reply of POST /produce/burst — bounds of the burst, not every id. */
interface BurstResponse {
  success: boolean;
  count: number;
  firstMessageId?: string;
  lastMessageId?: string;
  error?: string;
}

/**
 * Completions per second over a sliding window of arrival times.
 *
 * Pure and exported so it can be unit-tested as soon as this repo has a frontend test runner
 * (`docs/TODO.md`); the rest of the counter is plumbing.
 *
 * @param timesMs arrival timestamps, oldest first
 * @param nowMs   the instant the rate is asked for
 * @param windowMs width of the sliding window
 */
export function computeRate(timesMs: number[], nowMs: number, windowMs: number): number {
  const inWindow = timesMs.filter(t => t >= nowMs - windowMs);
  if (inWindow.length < 2) return 0;
  // Span floored at 1 s: two completions 30 ms apart must not be reported as 66/s. This under-reports
  // for the first second of a burst, then converges — an honest floor beats a spike.
  const spanMs = Math.max(nowMs - inWindow[0], 1000);
  return (inWindow.length * 1000) / spanMs;
}

/**
 * Work Queue / Competing Consumers pattern demonstration.
 *
 * Features:
 * - Demo mode (Slow / Fast) retiming the running workers: simulated work time + `minIdle`
 * - Start/Stop job production buttons, plus a one-click burst that queues a real backlog
 * - Live completion count and throughput (jobs/s), measured from the done-stream WebSocket events
 * - Configurable sleep interval between jobs
 * - Add / remove / kill workers at runtime (1..8); one done-stream viewer per running worker
 * - DLQ stream viewer
 */
@Component({
  selector: 'app-work-queue',
  standalone: true,
  imports: [CommonModule, FormsModule, StreamViewerComponent, MermaidDiagramComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="work-queue-container">
      <div class="page-header">
        <h2>Work Queue / Competing Consumers</h2>
        <p class="description">
          Competing consumers: N workers share one consumer group, so each job is processed by exactly
          one of them. Add or remove workers below and watch the load redistribute.
          1 in 10 jobs fails and goes to DLQ after 2 retries.
        </p>
      </div>
    
      <!-- Controls Section -->
      <div class="controls-section">
        <!-- Demo pace. Governs both rows below, hence its place at the top. -->
        @if (demo) {
          <div class="controls-row pace-row">
            <div class="mode-selector">
              <label for="demo-mode">Demo mode:</label>
              <select id="demo-mode" [ngModel]="demo.mode" (ngModelChange)="setDemoMode($event)">
                <!-- [value], not [ngValue]: the mode is a plain string, so this keeps the DOM value the
                mode name itself instead of Angular's "0: 'SLOW'" index key. -->
                @for (opt of demo.modes; track opt) {
                  <option [value]="opt.name">
                    {{ opt.label }} (work time: {{ opt.workMs }} ms, idleTime: {{ opt.minIdleMs }} ms)
                  </option>
                }
              </select>
            </div>
            <div class="mode-hint">
              A job holds its worker for <strong>{{ demo.workMs }} ms</strong>; an unacknowledged job becomes
              claimable by a peer after <strong>{{ demo.minIdleMs }} ms</strong> idle
              (workers poll every {{ demo.pollMs }} ms).
            </div>
          </div>
        }
    
        <div class="controls-row">
          <button
            class="btn btn-start"
            [disabled]="isProducing"
            (click)="startProducing()">
            ▶ Start Producing Jobs
          </button>
    
          <button
            class="btn btn-stop"
            [disabled]="!isProducing"
            (click)="stopProducing()">
            ⏹ Stop Producing Jobs
          </button>
    
          @if (demo) {
            <button
              class="btn btn-burst"
              (click)="burst()"
              title="Queue the jobs in one pipelined XADD, so the pool has a real backlog to drain — the steady producer alone never builds one">
              ⚡ Burst {{ demo.burstSize }} jobs
            </button>
          }
    
          <button
            class="btn btn-clear"
            [disabled]="isProducing"
            (click)="clearAllStreams()">
            🗑 Clear All
          </button>
    
          <div class="sleep-selector">
            <label for="sleep-between-jobs">Sleep between jobs:</label>
            <select id="sleep-between-jobs" [(ngModel)]="selectedSleep" [disabled]="isProducing">
              @for (opt of sleepOptions; track opt) {
                <option [ngValue]="opt.value">
                  {{ opt.label }}
                </option>
              }
            </select>
          </div>
    
        </div>
    
        <!-- Worker pool controls -->
        @if (workers) {
          <div class="controls-row workers-row">
            <button
              class="btn btn-add"
              [disabled]="workers.count >= workers.max"
              (click)="addWorker()">
              + Add worker
            </button>
            <button
              class="btn btn-remove"
              [disabled]="workers.count <= workers.min"
              (click)="removeWorker(false)"
              title="Graceful: the worker finishes its current job before stopping">
              − Remove worker
            </button>
            <button
              class="btn btn-kill"
              [disabled]="workers.count <= workers.min"
              (click)="removeWorker(true)"
              title="Abrupt: the current job is left PENDING and another worker reclaims it">
              💀 Kill worker
            </button>
            <div class="job-counter">
              Workers: <strong>{{ workers.count }}</strong> / {{ workers.max }}
            </div>
            <!-- Input count next to output count: the gap between them is the queue plus the DLQ. -->
            @if (jobsProduced > 0) {
              <div class="job-counter">
                Jobs produced: <strong>{{ jobsProduced }}</strong>
              </div>
            }
            @if (completedTotal > 0) {
              <div
                class="job-counter throughput"
                title="Entries written to the workers' done streams. A job routed to the DLQ is not a completion, so this trails 'Jobs produced' by the 1-in-10 failures.">
                Completed: <strong>{{ completedTotal }}</strong>
                · <strong>{{ completionRate | number:'1.1-1' }}</strong>/s
                <span class="peak">peak {{ peakRate | number:'1.1-1' }}/s</span>
              </div>
            }
            @if (workerMessage) {
              <div class="worker-message">{{ workerMessage }}</div>
            }
          </div>
        }
      </div>
    
      @if (streams) {
        <!-- Job Stream (input) -->
        <div class="stream-section">
          <h3>📥 Job Stream (Input)</h3>
          <div class="stream-row single">
            <app-stream-viewer
              [stream]="streams.jobStream"
              [group]="streams.group"
              [consumer]="'viewer'"
              [pageSize]="10">
            </app-stream-viewer>
          </div>
        </div>
        <!-- Workers Done Streams — one panel per running worker -->
        <div class="stream-section">
          <h3>✅ Workers Done Streams</h3>
          <div class="stream-row workers">
            @for (doneStream of streams.doneStreams; track trackByStream($index, doneStream)) {
              <app-stream-viewer
                [stream]="doneStream"
                [group]="streams.group"
                [consumer]="'viewer'"
                [pageSize]="10">
              </app-stream-viewer>
            }
          </div>
        </div>
        <!-- DLQ Stream -->
        <div class="stream-section">
          <h3>❌ Dead Letter Queue</h3>
          <div class="stream-row single">
            <app-stream-viewer
              [stream]="streams.dlqStream"
              [group]="streams.group"
              [consumer]="'viewer'"
              [pageSize]="10">
            </app-stream-viewer>
          </div>
        </div>
      }
    
      <!-- Architecture Diagram -->
      <app-mermaid-diagram
        title="View Architecture & Sequence Diagrams"
        [architectureDiagram]="diagrams.workQueue.architecture"
        [sequenceDiagram]="diagrams.workQueue.sequence">
      </app-mermaid-diagram>
    
      <!-- How it Works Section -->
      <div class="info-box">
        <div class="info-header">
          <span class="info-icon">ℹ️</span>
          <h3>How Work Queue / Competing Consumers Works</h3>
        </div>
        <div class="info-content">
          <div class="info-section">
            <h4>📤 Job Production</h4>
            <ol>
              <li><strong>Jobs are generated</strong> in the Angular frontend and sent via REST API to Spring Boot</li>
              <li><strong>Spring adds job</strong> to <code>jobs.imageProcessing.v1</code> stream via <code>XADD</code></li>
              <li><strong>Job payload</strong> contains: <code>jobId</code>, <code>processingType</code> (OK or Error), <code>createdAt</code></li>
              <li><strong>1 in 10 jobs</strong> is marked as <code>Error</code> to simulate failures</li>
            </ol>
          </div>
          <div class="info-section">
            <h4>👷 Worker Processing (one Virtual Thread per worker)</h4>
            <ol>
              <li><strong>4 workers start</strong> automatically on Spring Boot startup; you can scale the pool from 1 to 8 at runtime</li>
              <li><strong>Each worker polls</strong> every {{ demo?.pollMs ?? '—' }}ms using <code>read_claim_or_dlq</code> Lua function</li>
              <li><strong>Consumer Group</strong> <code>jobs-group</code> ensures no duplicate processing</li>
              <li><strong>On success (OK)</strong>: Job copied to <code>jobs.done.worker-X</code> stream + <code>XACK</code></li>
              <li><strong>On failure (Error)</strong>: No <code>XACK</code> → message stays in PENDING</li>
            </ol>
          </div>
          <div class="info-section">
            <h4>🔄 Retry & DLQ Logic</h4>
            <ol>
              <li><strong>Failed jobs</strong> remain in PENDING entries (no ACK)</li>
              <li><strong>After {{ demo?.minIdleMs ?? '—' }}ms idle</strong> (the demo mode's <code>minIdle</code>), another worker can
              claim the job via <code>XREADGROUP CLAIM</code></li>
              <li><strong>Max 2 delivery attempts</strong>: After 2 failures, job is routed to DLQ</li>
              <li><strong><code>minIdle</code> must outlast processing</strong>: otherwise a free worker claims a job its
              busy peer is still working on and the job runs <em>twice</em>, silently. Both demo modes keep a 2× margin</li>
              <li><strong>Killing a worker costs one attempt</strong>: kill the holder of the same job twice and it lands in the DLQ</li>
              <li><strong>DLQ routing</strong>: <code>XCLAIM</code> + <code>XADD</code> to DLQ + <code>XACK</code> (atomic via Lua)</li>
            </ol>
          </div>
          <div class="info-section">
            <h4>🔧 Technical Details</h4>
            <ul>
              <li><strong>Lua Function</strong>: <code>read_claim_or_dlq</code> handles read + claim + DLQ atomically</li>
              <li><strong>Virtual Threads</strong>: Java 21 lightweight threads for efficient blocking I/O</li>
              <li><strong>Streams</strong>:
              <code>jobs.imageProcessing.v1</code> (input),
              <code>jobs.done.worker-1..N</code> (one per worker, output),
              <code>jobs.imageProcessing.v1:dlq</code> (failures)
            </li>
            <li><strong>WebSocket</strong>: Real-time UI updates via <code>MESSAGE_PRODUCED</code> / <code>MESSAGE_DELETED</code> events</li>
          </ul>
        </div>
        <div class="info-section">
          <h4>📈 Horizontal Scalability</h4>
          <ul>
            <li><strong>Add more workers</strong>: Consumer Groups distribute load automatically — use the buttons above</li>
            <li><strong>Use <em>Burst</em> to see it</strong>: the steady producer never builds a backlog (one Fast
            worker keeps up with it), so the <code>/s</code> figure tracks the producer. Queue a burst, then
          watch the completion rate scale with the number of workers</li>
          <li><strong>Removing a worker keeps its consumer</strong>: no <code>XGROUP DELCONSUMER</code>, so a job in flight is reclaimed instead of lost</li>
          <li><strong>No coordination needed</strong>: Redis handles message distribution</li>
          <li><strong>At-least-once delivery</strong>: Each message is processed at least once (idempotency recommended)</li>
        </ul>
      </div>
    </div>
    </div>
    </div>
    `,
  styles: [`
    .work-queue-container {
      padding: 20px;
      max-width: 1400px;
      margin: 0 auto;
    }

    .page-header {
      margin-bottom: 24px;
    }

    .page-header h2 {
      margin: 0 0 8px 0;
      color: #1e293b;
    }

    .description {
      color: #64748b;
      margin: 0;
    }

    .controls-section {
      background: white;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
      border: 1px solid #e2e8f0;
    }

    .controls-row {
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }

    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-start {
      background: #16a34a;
      color: white;
    }

    .btn-start:hover:not(:disabled) {
      background: #15803d;
    }

    .btn-stop {
      background: #dc2626;
      color: white;
    }

    .btn-stop:hover:not(:disabled) {
      background: #b91c1c;
    }

    .btn-clear {
      background: #6b7280;
      color: white;
    }

    .btn-burst {
      background: #7c3aed;
      color: white;
    }

    .btn-burst:hover:not(:disabled) {
      background: #6d28d9;
    }

    .btn-clear:hover:not(:disabled) {
      background: #4b5563;
    }

    .btn-add {
      background: #2563eb;
      color: white;
    }

    .btn-add:hover:not(:disabled) {
      background: #1d4ed8;
    }

    .btn-remove {
      background: #f59e0b;
      color: white;
    }

    .btn-remove:hover:not(:disabled) {
      background: #d97706;
    }

    .btn-kill {
      background: #7f1d1d;
      color: white;
    }

    .btn-kill:hover:not(:disabled) {
      background: #641515;
    }

    .workers-row {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid #e2e8f0;
    }

    .pace-row {
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid #e2e8f0;
      gap: 12px;
    }

    .mode-selector {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .mode-selector label {
      color: #64748b;
      font-size: 14px;
      font-weight: 600;
    }

    .mode-selector select {
      padding: 8px 12px;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      background: white;
      font-size: 14px;
      font-weight: 600;
      color: #1e293b;
    }

    /* Explains what the two numbers in the option label actually do. */
    .mode-hint {
      color: #64748b;
      font-size: 13px;
      line-height: 1.5;
      flex: 1 1 320px;
    }

    .mode-hint strong {
      color: #334155;
    }

    .worker-message {
      color: #b45309;
      font-size: 14px;
    }

    .sleep-selector {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .sleep-selector label {
      color: #64748b;
      font-size: 14px;
    }

    .sleep-selector select {
      padding: 8px 12px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      background: white;
      font-size: 14px;
    }

    .job-counter {
      color: #64748b;
      font-size: 14px;
      padding: 8px 12px;
      background: #f1f5f9;
      border-radius: 6px;
    }

    /* The pool's output rate — the number that should move when you add or kill a worker. */
    .throughput {
      background: #eef2ff;
      color: #4338ca;
      font-variant-numeric: tabular-nums;
    }

    .throughput strong {
      color: #312e81;
    }

    .throughput .peak {
      color: #6366f1;
      font-size: 12px;
      margin-left: 6px;
    }

    .stream-section {
      margin-bottom: 24px;
    }

    .stream-section h3 {
      margin: 0 0 12px 0;
      color: #1e293b;
      font-size: 16px;
    }

    .stream-row {
      display: grid;
      gap: 16px;
    }

    .stream-row.single {
      grid-template-columns: 1fr;
    }

    /*
     * At most 4 workers per row, so the 8-worker maximum reads as two complete rows of 4 on any
     * screen. The min track is the exact width a 4-column layout would give (25% minus this column's
     * share of the 3 gaps: 3 * 16px / 4 = 12px), so auto-fit can never fit a 5th — plain
     * minmax(220px, 1fr) yielded 5 columns at 1360px and 6 at 1600px, hence a ragged 5+3 or 6+2.
     * Still auto-fit, not repeat(4, 1fr): auto-fit collapses the empty tracks, so 1-3 workers stretch
     * to fill the row instead of huddling in the left quarter.
     */
    .stream-row.workers {
      grid-template-columns: repeat(auto-fit, minmax(max(220px, calc(25% - 12px)), 1fr));
    }

    @media (max-width: 1200px) {
      .stream-row.workers {
        grid-template-columns: repeat(2, 1fr);
      }
    }

    @media (max-width: 768px) {
      .stream-row.workers {
        grid-template-columns: 1fr;
      }
    }

    /* Info Box Styles */
    .info-box {
      margin-top: 24px;
      background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
      border: 1px solid #cbd5e1;
      border-radius: 12px;
      padding: 24px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
    }

    .info-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid #e2e8f0;
    }

    .info-icon {
      font-size: 24px;
    }

    .info-header h3 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      color: #1e293b;
    }

    .info-content {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
    }

    .info-section {
      background: white;
      border-radius: 8px;
      padding: 16px;
      border: 1px solid #e2e8f0;
    }

    .info-section h4 {
      margin: 0 0 12px 0;
      font-size: 14px;
      font-weight: 600;
      color: #334155;
    }

    .info-section ol,
    .info-section ul {
      margin: 0;
      padding-left: 20px;
      font-size: 13px;
      color: #475569;
      line-height: 1.8;
    }

    .info-section li {
      margin-bottom: 4px;
    }

    .info-section code {
      background: #e2e8f0;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 12px;
      color: #0f172a;
    }

    .info-section strong {
      color: #1e293b;
    }
  `]
})
export class WorkQueueComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private refreshService = inject(StreamRefreshService);
  private wsService = inject(WebSocketService);
  private cdr = inject(ChangeDetectorRef);
  diagrams = inject(DiagramDefinitionsService);
  private apiUrl = `${API_BASE}/work-queue`;

  // Production state
  isProducing = false;
  jobsProduced = 0;
  private jobCounter = 0;
  private productionInterval: ReturnType<typeof setTimeout> | null = null;

  // Sleep options. Every DemoMode.producerSleepMs the backend suggests should land on one of these
  // values; closestSleepOption() keeps the select rendering an option even if one drifts.
  sleepOptions: SleepOption[] = [
    { label: '0.1s', value: 100 },
    { label: '0.5s', value: 500 },
    { label: '1s', value: 1000 },
    { label: '2s', value: 2000 }
  ];
  selectedSleep = 500; // Overwritten by the demo mode's suggested pace once /streams answers

  // Stream names, worker-pool state and demo timings come from the backend — the single source of truth.
  streams: WorkQueueStreams | null = null;
  workers: WorkerPool | null = null;
  demo: DemoModeState | null = null;
  workerMessage = '';

  // Throughput. Every done-stream entry already reaches this page as a MESSAGE_PRODUCED event, so the
  // rate is measured from what the UI actually receives — no extra endpoint, no polling.
  completedTotal = 0;
  completionRate = 0;
  peakRate = 0;
  private completionTimes: number[] = [];
  private eventSubscription: Subscription | null = null;
  private rateTimer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.loadStreams();

    // The child stream viewers have usually opened the socket already; connect() is a no-op then, and
    // WebSocketService is a root singleton, so this shares the one SockJS connection.
    this.wsService.connect();
    this.eventSubscription = this.wsService.getEvents().subscribe(event => this.onStreamEvent(event));

    // Recompute on a timer rather than per event: the rate has to decay to 0 when production stops, and
    // this keeps change detection at 2.5 Hz instead of once per completion (~80/s while a burst drains).
    this.rateTimer = setInterval(() => this.refreshRate(), 400);
  }

  /** Counts one completion per entry written to a worker's done stream. */
  private onStreamEvent(event: DLQEvent): void {
    if (event.eventType !== 'MESSAGE_PRODUCED' || !event.streamName || !this.streams) return;
    // Prefix, not the doneStreams list: a job finished by a worker that was just removed still counts.
    if (!event.streamName.startsWith(this.streams.doneStreamPrefix)) return;

    this.completedTotal++;
    this.completionTimes.push(Date.now());
  }

  private refreshRate(): void {
    const now = Date.now();
    const windowMs = this.rateWindowMs();
    this.completionTimes = this.completionTimes.filter(t => t >= now - windowMs);

    const rate = Math.round(computeRate(this.completionTimes, now, windowMs) * 10) / 10;
    const peak = Math.max(this.peakRate, rate);
    if (rate === this.completionRate && peak === this.peakRate) return; // idle: no change detection

    this.completionRate = rate;
    this.peakRate = peak;
    this.cdr.markForCheck();
  }

  /**
   * Window scaled to the demo mode: 5 s holds barely 8 samples in Slow (one job per worker per 2 s),
   * which would make the figure jump between two values.
   */
  private rateWindowMs(): number {
    return Math.max(5000, 3 * (this.demo?.workMs ?? 0));
  }

  /**
   * Queue a whole backlog at once. Without this the steady producer is the bottleneck — one Fast worker
   * already keeps up with it — so the completion rate would not move when the pool grows.
   */
  burst(): void {
    if (!this.demo) return;
    const count = this.demo.burstSize;

    this.workerMessage = '';
    this.http.post<BurstResponse>(`${this.apiUrl}/produce/burst`, null, { params: { count } }).subscribe({
      next: (response) => {
        this.jobsProduced += response.count ?? count;
        this.cdr.markForCheck();
        this.refreshService.triggerRefresh();
      },
      error: (err) => {
        this.workerMessage = err?.error?.error ?? 'Failed to produce the burst';
        this.cdr.markForCheck();
      }
    });
  }

  /** Keeps existing viewers alive when the worker count changes. */
  trackByStream = (_index: number, stream: string): string => stream;

  private loadStreams(): void {
    this.http.get<{ streams: WorkQueueStreams; workers: WorkerPool; demoMode: DemoModeState }>(
      `${this.apiUrl}/streams`).subscribe({
      next: (response) => {
        this.streams = response.streams;
        this.workers = response.workers;
        this.applyDemoModeState(response.demoMode);
        this.cdr.markForCheck();
      },
      error: (err) => console.error('Failed to load work queue streams:', err)
    });
  }

  /**
   * Switch the demo pace. The backend retimes the running workers (work time, `minIdle`, poll
   * interval); the producer loop lives here, so we also move "Sleep between jobs" to the pace the
   * mode suggests. Changing mode while producing is allowed — the new interval applies to the next job.
   */
  setDemoMode(mode: string): void {
    this.http.put<DemoModeState>(`${this.apiUrl}/demo-mode`, null, { params: { mode } }).subscribe({
      next: (state) => {
        this.applyDemoModeState(state);
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('Failed to switch demo mode:', err);
        this.workerMessage = err?.error?.error ?? 'Failed to switch demo mode';
        this.cdr.markForCheck();
      }
    });
  }

  private applyDemoModeState(state: DemoModeState): void {
    this.demo = state;
    // The mode's suggested producer pace must map onto an existing option, or the select renders blank.
    this.selectedSleep = this.closestSleepOption(state.producerSleepMs);
  }

  private closestSleepOption(target: number): number {
    return this.sleepOptions.reduce((best, opt) =>
      Math.abs(opt.value - target) < Math.abs(best - target) ? opt.value : best, this.selectedSleep);
  }

  addWorker(): void {
    this.mutatePool(this.http.post<WorkerMutationResponse>(`${this.apiUrl}/workers`, null));
  }

  /** @param kill true leaves the in-flight job PENDING for another worker to reclaim. */
  removeWorker(kill: boolean): void {
    this.mutatePool(
      this.http.delete<WorkerMutationResponse>(`${this.apiUrl}/workers`, { params: { kill } }));
  }

  private mutatePool(request: Observable<WorkerMutationResponse>): void {
    this.workerMessage = '';
    request.subscribe({
      next: () => {
        this.loadStreams();
        this.refreshService.triggerRefresh();
      },
      error: (err) => {
        // 409 = a pool bound was reached; the backend left the pool untouched.
        this.workerMessage = err?.error?.error ?? 'Failed to change the worker pool';
        this.cdr.markForCheck();
      }
    });
  }

  ngOnDestroy(): void {
    this.stopProducing();
    this.eventSubscription?.unsubscribe();
    if (this.rateTimer) {
      clearInterval(this.rateTimer);
      this.rateTimer = null;
    }
  }

  startProducing(): void {
    if (this.isProducing) return;

    this.isProducing = true;
    this.produceNextJob();
  }

  stopProducing(): void {
    this.isProducing = false;
    if (this.productionInterval) {
      clearTimeout(this.productionInterval);
      this.productionInterval = null;
    }
  }

  private produceNextJob(): void {
    if (!this.isProducing) return;

    this.jobCounter++;
    // 1 in 10 jobs is an Error
    const processingType = (this.jobCounter % 10 === 0) ? 'Error' : 'OK';

    this.http.post<ProduceResponse>(`${this.apiUrl}/produce`, null, {
      params: { processingType }
    }).subscribe({
      next: (response) => {
        if (response.success) {
          this.jobsProduced++;
          this.cdr.markForCheck();
        }
        // Schedule next job
        this.productionInterval = setTimeout(() => this.produceNextJob(), this.selectedSleep);
      },
      error: (error) => {
        console.error('Failed to produce job:', error);
        // Retry after delay
        this.productionInterval = setTimeout(() => this.produceNextJob(), this.selectedSleep);
      }
    });
  }

  clearAllStreams(): void {
    // Call dedicated endpoint that clears streams and recreates consumer group
    this.http.delete(`${this.apiUrl}/clear`).subscribe({
      next: () => {
        console.log('All work queue streams cleared');
        this.jobsProduced = 0;
        this.jobCounter = 0;
        this.workerMessage = '';
        this.completedTotal = 0;
        this.completionRate = 0;
        this.peakRate = 0;
        this.completionTimes = [];
        this.cdr.markForCheck();

        // Refresh all stream viewers
        setTimeout(() => {
          this.refreshService.triggerRefresh();
        }, 200);
      },
      error: (err) => console.error('Failed to clear streams:', err)
    });
  }
}

