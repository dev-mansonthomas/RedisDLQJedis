import { Component, OnDestroy, signal, inject, ChangeDetectionStrategy } from '@angular/core';

import { HttpClient } from '@angular/common/http';
import { StreamRefreshService } from '../../services/stream-refresh.service';
import { DlqAction, DlqScenarioService } from '../../services/dlq-scenario.service';
import { ConfirmDialogComponent } from '../confirm-dialog/confirm-dialog.component';
import { API_BASE } from '../../api.config';

/**
 * Component for processing DLQ messages with success or failure simulation.
 * Provides two actions:
 * - Process & Success: Gets next message and acknowledges it
 * - Process & Fail: Gets next message but doesn't acknowledge (will retry)
 */
interface ProcessResponse {
  success: boolean;
  message?: string;
}

/** How long a status line stays on screen. Long enough to actually read it. */
const STATUS_VISIBLE_MS = 10_000;

/**
 * Outcomes that mean the *message* failed, even though the REST call succeeded.
 * `NACK_SILENT` is absent on purpose: a graceful release refunds the retry budget, so nothing failed.
 */
const FAILING_OUTCOMES = new Set<string>(['NO_ACK', 'NACK_FAIL', 'NACK_FATAL']);

@Component({
  selector: 'app-dlq-actions',
  standalone: true,
  imports: [ConfirmDialogComponent],
  template: `
    <div class="dlq-actions">
      <div class="actions-header">
        <h3 class="actions-title">Message Processing</h3>
      </div>
    
      <div class="actions-content">
        <button
          class="action-button generate"
          [disabled]="isProcessing()"
          (click)="generateMessages()">
          <span class="button-icon">⚡</span>
          <span class="button-text">Generate Messages</span>
        </button>
    
        <div class="separator"></div>
    
        <button
          class="action-button success"
          [disabled]="isProcessing()"
          (click)="process('ACK')">
          <span class="button-icon">✓</span>
          <span class="button-text">Process & Success</span>
        </button>
    
        <button
          class="action-button fail"
          [disabled]="isProcessing()"
          title="Simulated crash: no ACK — stays owned, retried only after minIdle; failure budget consumed"
          (click)="process('NO_ACK')">
          <span class="button-icon">✗</span>
          <span class="button-text">Process & Fail (timeout)</span>
        </button>
    
        <button
          class="action-button explicit"
          [disabled]="isProcessing()"
          title="XNACK FAIL: released immediately (no minIdle wait); failure budget consumed"
          (click)="process('NACK_FAIL')">
          <span class="button-icon">⚡</span>
          <span class="button-text">Process & Explicit Fail</span>
        </button>
    
        <button
          class="action-button poison"
          [disabled]="isProcessing()"
          title="XNACK FATAL: delivery counter forced to max — swept to the DLQ by the next poll, immediately"
          (click)="process('NACK_FATAL')">
          <span class="button-icon">☠️</span>
          <span class="button-text">Process & Poison</span>
        </button>
    
        <button
          class="action-button silent"
          [disabled]="isProcessing()"
          title="XNACK SILENT: returned untouched (e.g. graceful shutdown) — counter reset to 0, failure budget refunded"
          (click)="process('NACK_SILENT')">
          <span class="button-icon">↩️</span>
          <span class="button-text">Process & Release (silent)</span>
        </button>
    
        <div class="separator"></div>
    
        <button
          class="action-button clear"
          [disabled]="isProcessing()"
          (click)="clearAllStreams()">
          <span class="button-icon">🗑️</span>
          <span class="button-text">Clear All Streams</span>
        </button>
    
        @if (statusMessage()) {
          <div class="status-message" [class.error]="isError()">
            {{ statusMessage() }}
          </div>
        }
      </div>
    </div>
    
    @if (pendingClear()) {
      <app-confirm-dialog
        title="Clear all streams?"
        message="This deletes test-stream and test-stream:dlq. It cannot be undone."
        detail="The consumer group is recreated on the next action, so the page keeps working."
        confirmLabel="Clear all"
        (confirmed)="confirmClear()"
        (cancelled)="pendingClear.set(false)">
      </app-confirm-dialog>
    }
    `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .dlq-actions {
      background: white;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      border: 1px solid #e2e8f0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .actions-header {
      padding: 12px 16px;
      border-bottom: 1px solid #e2e8f0;
      background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
    }

    .actions-title {
      font-size: 14px;
      font-weight: 600;
      color: #1e293b;
      margin: 0;
    }

    .actions-content {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      flex: 1;
    }

    .action-button {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px 16px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    }

    .action-button:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }

    .action-button:active:not(:disabled) {
      transform: translateY(0);
    }

    .action-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .action-button.success {
      background: linear-gradient(135deg, #10b981 0%, #059669 100%);
      color: white;
    }

    .action-button.success:hover:not(:disabled) {
      background: linear-gradient(135deg, #059669 0%, #047857 100%);
    }

    .action-button.fail {
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      color: white;
    }

    .action-button.fail:hover:not(:disabled) {
      background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
    }

    .action-button.explicit {
      background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
      color: white;
    }

    .action-button.explicit:hover:not(:disabled) {
      background: linear-gradient(135deg, #ea580c 0%, #c2410c 100%);
    }

    .action-button.poison {
      background: linear-gradient(135deg, #7f1d1d 0%, #450a0a 100%);
      color: white;
    }

    .action-button.poison:hover:not(:disabled) {
      background: linear-gradient(135deg, #991b1b 0%, #7f1d1d 100%);
    }

    .action-button.silent {
      background: linear-gradient(135deg, #64748b 0%, #475569 100%);
      color: white;
    }

    .action-button.silent:hover:not(:disabled) {
      background: linear-gradient(135deg, #475569 0%, #334155 100%);
    }

    .action-button.generate {
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
      color: white;
    }

    .action-button.generate:hover:not(:disabled) {
      background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
    }

    .action-button.clear {
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      color: white;
    }

    .action-button.clear:hover:not(:disabled) {
      background: linear-gradient(135deg, #d97706 0%, #b45309 100%);
    }

    .separator {
      height: 1px;
      background: #e2e8f0;
      margin: 8px 0;
    }

    .button-icon {
      font-size: 18px;
      font-weight: bold;
    }

    .button-text {
      font-size: 14px;
    }

    .status-message {
      padding: 12px;
      border-radius: 6px;
      font-size: 13px;
      background: #f0fdf4;
      color: #166534;
      border: 1px solid #bbf7d0;
      text-align: center;
    }

    .status-message.error {
      background: #fef2f2;
      color: #991b1b;
      border: 1px solid #fecaca;
    }
  `]
})
export class DlqActionsComponent implements OnDestroy {
  private http = inject(HttpClient);
  private refreshService = inject(StreamRefreshService);
  private scenarios = inject(DlqScenarioService);
  private apiUrl = `${API_BASE}/dlq`;

  isProcessing = signal(false);
  statusMessage = signal('');
  isError = signal(false);

  /** Single timer shared by every status line — see {@link setStatus}. */
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether the destructive-clear confirmation is on screen. */
  pendingClear = signal(false);

  generateMessages(): void {
    this.scenarios.record('GENERATE');
    this.isProcessing.set(true);
    this.setStatus('Generating messages...', false);

    // Six, not four: with maxDeliveries at 2 a single scenario burns three clicks, so four messages
    // ran out mid-demonstration.
    const messages = this.createRandomMessages(6);
    let completed = 0;
    let errors = 0;

    // Send each message
    messages.forEach((message, index) => {
      setTimeout(() => {
        this.http.post<void>(`${this.apiUrl}/produce`, {
          streamName: 'test-stream',
          payload: message
        }).subscribe({
          next: () => {
            completed++;
            if (completed + errors === messages.length) {
              this.isProcessing.set(false);
              if (errors === 0) {
                this.setStatus(`✓ Generated ${completed} messages successfully`, false);
              } else {
                this.setStatus(`⚠ Generated ${completed}/${messages.length} messages (${errors} failed)`, true);
              }
            }
          },
          error: () => {
            errors++;
            if (completed + errors === messages.length) {
              this.isProcessing.set(false);
              this.setStatus(`⚠ Generated ${completed}/${messages.length} messages (${errors} failed)`, true);
            }
          }
        });
      }, index * 100); // Stagger requests by 100ms
    });
  }

  private createRandomMessages(count: number): Record<string, string>[] {
    const messages: Record<string, string>[] = [];
    const reasons = ['payment_failed', 'out_of_stock', 'customer_request', 'fraud_detected'];

    for (let i = 0; i < count; i++) {
      const orderId = 1000 + Math.floor(Math.random() * 9000); // Random order ID 1000-9999
      const isCancelled = Math.random() > 0.8; // 20% chance of cancelled (80% created)

      if (isCancelled) {
        // order.cancelled message
        messages.push({
          type: 'order.cancelled',
          order_id: orderId.toString(),
          reason: reasons[Math.floor(Math.random() * reasons.length)]
        });
      } else {
        // order.created message
        const amount = (Math.random() * 100 + 10).toFixed(2); // Random amount 10.00-110.00
        messages.push({
          type: 'order.created',
          order_id: orderId.toString(),
          amount: amount
        });
      }
    }

    return messages;
  }

  /** Asks first. The deletion itself lives in {@link confirmClear}. */
  clearAllStreams(): void {
    this.pendingClear.set(true);
  }

  confirmClear(): void {
    this.pendingClear.set(false);
    this.scenarios.record('CLEAR');
    this.isProcessing.set(true);
    this.setStatus('Clearing streams...', false);

    // Delete both streams
    const streams = ['test-stream', 'test-stream:dlq'];
    let completed = 0;
    let errors = 0;

    streams.forEach((streamName) => {
      this.http.delete<void>(`${this.apiUrl}/stream/${streamName}`).subscribe({
        next: () => {
          completed++;
          if (completed + errors === streams.length) {
            this.isProcessing.set(false);
            if (errors === 0) {
              this.setStatus(`✓ Cleared ${completed} streams successfully`, false);
            } else {
              this.setStatus(`⚠ Cleared ${completed}/${streams.length} streams (${errors} failed)`, true);
            }

            // Trigger refresh of all stream viewers
            this.refreshService.triggerRefresh();

          }
        },
        error: () => {
          errors++;
          if (completed + errors === streams.length) {
            this.isProcessing.set(false);
            if (completed > 0) {
              this.setStatus(`⚠ Cleared ${completed}/${streams.length} streams (${errors} failed)`, true);
            } else {
              this.setStatus('Error: Failed to clear streams', true);
            }

            // Trigger refresh even on partial success
            if (completed > 0) {
              this.refreshService.triggerRefresh();
            }

          }
        }
      });
    });
  }

  /** outcome: ACK | NO_ACK | NACK_FAIL | NACK_FATAL | NACK_SILENT (see ProcessOutcome, backend). */
  process(outcome: Exclude<DlqAction, 'GENERATE' | 'CLEAR'>): void {
    this.scenarios.record(outcome);
    this.isProcessing.set(true);
    this.setStatus('Processing...', false);

    this.http.post<ProcessResponse>(`${this.apiUrl}/process`, { outcome }).subscribe({
      next: (response) => {
        // A failing outcome returns success:true — the *call* worked, the *message* did not. Colouring
        // by the HTTP flag alone is what painted "processing failed" in green.
        const failed = !response.success || FAILING_OUTCOMES.has(outcome);
        this.setStatus(
          response.message || (response.success ? 'Message processed successfully' : 'No messages to process'),
          failed);
        this.isProcessing.set(false);
      },
      error: (error) => {
        this.setStatus('Error: ' + (error.error?.message || 'Failed to process message'), true);
        this.isProcessing.set(false);
      }
    });
  }

  /**
   * Shows a status line for {@link STATUS_VISIBLE_MS}, or until the next one replaces it.
   *
   * The single shared timer is the point: with one timer per call, a status posted 2 s after another
   * was wiped by the *earlier* call's timeout. Ten seconds made that race trivial to hit.
   */
  private setStatus(message: string, isError: boolean): void {
    if (this.statusTimer !== null) {
      clearTimeout(this.statusTimer);
    }
    this.statusMessage.set(message);
    this.isError.set(isError);
    this.statusTimer = setTimeout(() => {
      this.statusMessage.set('');
      this.statusTimer = null;
    }, STATUS_VISIBLE_MS);
  }

  ngOnDestroy(): void {
    if (this.statusTimer !== null) {
      clearTimeout(this.statusTimer);
    }
  }
}

