import { Component, OnDestroy, inject, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { StreamViewerComponent } from '../stream-viewer/stream-viewer.component';
import { StreamRefreshService } from '../../services/stream-refresh.service';
import { MermaidDiagramComponent } from '../mermaid-diagram/mermaid-diagram.component';
import { DiagramDefinitionsService } from '../../services/diagram-definitions.service';
import { API_BASE } from '../../api.config';

interface SleepOption {
  label: string;
  value: number;
}

/**
 * Fan-Out / Broadcast pattern demonstration.
 * 
 * Key difference from Work Queue:
 * - Each worker has its OWN consumer group (fanout-group-1, fanout-group-2, etc.)
 * - Each message is delivered to ALL workers (broadcast)
 * - Still uses DLQ for failed messages after max retries
 */
interface ProduceResponse {
  success: boolean;
}

@Component({
  selector: 'app-fan-out',
  standalone: true,
  imports: [FormsModule, StreamViewerComponent, MermaidDiagramComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fan-out-container">
      <div class="page-header">
        <h2>Fan-Out / Broadcast (Durable)</h2>
        <p class="description">
          Each event is delivered to ALL 4 workers (each has its own Consumer Group).
          Unlike Pub/Sub: messages are persisted. Unlike Work Queue: no competing consumers.
        </p>
      </div>
    
      <!-- Controls Section -->
      <div class="controls-section">
        <div class="controls-row">
          <button
            class="btn btn-start"
            [disabled]="isProducing"
            (click)="startProducing()">
            ▶ Start Producing Events
          </button>
    
          <button
            class="btn btn-stop"
            [disabled]="!isProducing"
            (click)="stopProducing()">
            ⏹ Stop Producing Events
          </button>
    
          <button
            class="btn btn-clear"
            [disabled]="isProducing"
            (click)="clearAllStreams()">
            🗑 Clear All
          </button>
    
          <div class="sleep-selector">
            <label for="fanout-sleep">Sleep between events:</label>
            <select id="fanout-sleep" [(ngModel)]="selectedSleep" [disabled]="isProducing">
              @for (opt of sleepOptions; track opt) {
                <option [ngValue]="opt.value">
                  {{ opt.label }}
                </option>
              }
            </select>
          </div>
    
          @if (eventsProduced > 0) {
            <div class="event-counter">
              Events produced: <strong>{{ eventsProduced }}</strong>
            </div>
          }
        </div>
      </div>
    
      <!-- Event Stream (input) -->
      <div class="stream-section">
        <h3>📥 Event Stream (Input)</h3>
        <div class="stream-row single">
          <app-stream-viewer
            [stream]="'fanout.events.v1'"
            [group]="'fanout-group-1'"
            [consumer]="'viewer'"
            [pageSize]="10">
          </app-stream-viewer>
        </div>
      </div>
    
      <!-- Workers Done Streams (each worker has its own copy) -->
      <div class="stream-section">
        <h3>✅ Workers Done Streams (each receives ALL events)</h3>
        <div class="stream-row workers">
          @for (w of [1,2,3,4]; track w) {
            <app-stream-viewer
              [stream]="'fanout.done.worker-' + w"
              [group]="'fanout-group-' + w"
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
            [stream]="'fanout.events.v1:dlq'"
            [group]="'fanout-group-1'"
            [consumer]="'viewer'"
            [pageSize]="10">
          </app-stream-viewer>
        </div>
      </div>
    
      <!-- Architecture Diagram -->
      <app-mermaid-diagram
        title="View Architecture & Sequence Diagrams"
        [architectureDiagram]="diagrams.fanOut.architecture"
        [sequenceDiagram]="diagrams.fanOut.sequence">
      </app-mermaid-diagram>
    
      <!-- How it Works Section -->
      <div class="info-box">
        <div class="info-header">
          <span class="info-icon">ℹ️</span>
          <h3>How Fan-Out / Broadcast Works</h3>
        </div>
        <div class="info-content">
          <div class="info-section">
            <h4>📤 Event Production</h4>
            <ol>
              <li><strong>Events are generated</strong> in the Angular frontend and sent via REST API to Spring Boot</li>
              <li><strong>Spring adds event</strong> to <code>fanout.events.v1</code> stream via <code>XADD</code></li>
              <li><strong>Event payload</strong> contains: <code>eventId</code>, <code>processingType</code>, <code>createdAt</code></li>
              <li><strong>1 in 10 events</strong> is marked as <code>Error</code> to simulate failures</li>
            </ol>
          </div>
          <div class="info-section">
            <h4>📡 Broadcast Pattern (Key Difference)</h4>
            <ol>
              <li><strong>Each worker has its OWN Consumer Group</strong>: <code>fanout-group-1</code> to <code>fanout-group-4</code></li>
              <li><strong>Each message delivered to ALL workers</strong>: Unlike Work Queue, no competing consumers</li>
              <li><strong>Independent progress</strong>: Each worker tracks its own position in the stream</li>
              <li><strong>Durability</strong>: Messages persist until explicitly deleted (unlike Pub/Sub)</li>
            </ol>
          </div>
          <div class="info-section">
            <h4>🔄 Retry & DLQ Logic (per worker)</h4>
            <ol>
              <li><strong>Each worker retries independently</strong>: Failure in one doesn't affect others</li>
              <li><strong>After 2 delivery attempts</strong>, failed event goes to DLQ for that worker</li>
              <li><strong>DLQ routing</strong>: Same Lua function <code>read_claim_or_dlq</code></li>
            </ol>
          </div>
        </div>
      </div>
    </div>
    `,
  styles: [`
    .fan-out-container {
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

    .btn-clear:hover:not(:disabled) {
      background: #4b5563;
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

    .event-counter {
      color: #64748b;
      font-size: 14px;
      padding: 8px 12px;
      background: #f1f5f9;
      border-radius: 6px;
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

    .stream-row.workers {
      grid-template-columns: repeat(4, 1fr);
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
export class FanOutComponent implements OnDestroy {
  private http = inject(HttpClient);
  private refreshService = inject(StreamRefreshService);
  private cdr = inject(ChangeDetectorRef);
  diagrams = inject(DiagramDefinitionsService);
  private apiUrl = `${API_BASE}/fan-out`;

  // Production state
  isProducing = false;
  eventsProduced = 0;
  private eventCounter = 0;
  private productionInterval: ReturnType<typeof setTimeout> | null = null;

  // Sleep options
  sleepOptions: SleepOption[] = [
    { label: '0.1s', value: 100 },
    { label: '0.5s', value: 500 },
    { label: '1s', value: 1000 },
    { label: '2s', value: 2000 }
  ];
  selectedSleep = 500;

  ngOnDestroy(): void {
    this.stopProducing();
  }

  startProducing(): void {
    if (this.isProducing) return;

    this.isProducing = true;
    this.produceNextEvent();
  }

  stopProducing(): void {
    this.isProducing = false;
    if (this.productionInterval) {
      clearTimeout(this.productionInterval);
      this.productionInterval = null;
    }
  }

  private produceNextEvent(): void {
    if (!this.isProducing) return;

    this.eventCounter++;
    // 1 in 10 events is an Error
    const processingType = (this.eventCounter % 10 === 0) ? 'Error' : 'OK';

    this.http.post<ProduceResponse>(`${this.apiUrl}/produce`, null, {
      params: { processingType }
    }).subscribe({
      next: (response) => {
        if (response.success) {
          this.eventsProduced++;
          this.cdr.markForCheck();
        }
        this.productionInterval = setTimeout(() => this.produceNextEvent(), this.selectedSleep);
      },
      error: (error) => {
        console.error('Failed to produce event:', error);
        this.productionInterval = setTimeout(() => this.produceNextEvent(), this.selectedSleep);
      }
    });
  }

  clearAllStreams(): void {
    this.http.delete(`${this.apiUrl}/clear`).subscribe({
      next: () => {
        console.log('All fan-out streams cleared');
        this.eventsProduced = 0;
        this.eventCounter = 0;
        this.cdr.markForCheck();

        setTimeout(() => {
          this.refreshService.triggerRefresh();
        }, 200);
      },
      error: (err) => console.error('Failed to clear streams:', err)
    });
  }
}

