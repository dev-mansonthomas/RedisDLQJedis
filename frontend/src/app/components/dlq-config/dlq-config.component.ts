import { Component, signal, inject, ChangeDetectionStrategy } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';

export interface DLQConfig {
  streamName: string;
  dlqStreamName: string;
  consumerGroup: string;
  consumerName: string;
  minIdleMs: number;
  count: number;
  maxDeliveries: number;
}

/**
 * Collapsible component for configuring DLQ parameters.
 * - Collapsed: Shows only maxRetry in read-only mode
 * - Expanded: Shows all parameters (read-only except maxRetry which is editable)
 */
@Component({
  selector: 'app-dlq-config',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="dlq-config">
      <!-- Collapsed View -->
      @if (!isExpanded()) {
        <div class="collapsed-view" (click)="toggleExpand()" role="button" tabindex="0" (keydown.enter)="toggleExpand()" (keydown.space)="toggleExpand()" [attr.aria-expanded]="isExpanded()">
          <div class="collapsed-content">
            <span class="collapsed-label">Max Deliveries:</span>
            <span class="collapsed-value">{{ config.maxDeliveries }}</span>
          </div>
          <div class="expand-icon">▼</div>
        </div>
      }
    
      <!-- Expanded View -->
      @if (isExpanded()) {
        <div class="expanded-view">
          <div class="header-row" (click)="toggleExpand()" role="button" tabindex="0" (keydown.enter)="toggleExpand()" (keydown.space)="toggleExpand()" [attr.aria-expanded]="isExpanded()">
            <h3 class="section-title">DLQ Configuration</h3>
            <div class="collapse-icon">▲</div>
          </div>
          <div class="config-section">
            <h4 class="subsection-title">Stream Configuration (Read-only)</h4>
            <div class="form-group">
              <label for="streamName">Main Stream Name</label>
              <input
                id="streamName"
                type="text"
                [(ngModel)]="config.streamName"
                placeholder="test-stream"
                class="form-input"
                readonly>
            </div>
            <div class="form-group">
              <label for="dlqStreamName">DLQ Stream Name</label>
              <input
                id="dlqStreamName"
                type="text"
                [(ngModel)]="config.dlqStreamName"
                placeholder="test-stream:dlq"
                class="form-input"
                readonly>
            </div>
            <div class="form-group">
              <label for="consumerGroup">Consumer Group</label>
              <input
                id="consumerGroup"
                type="text"
                [(ngModel)]="config.consumerGroup"
                placeholder="test-group"
                class="form-input"
                readonly>
            </div>
            <div class="form-group">
              <label for="consumerName">Consumer Name</label>
              <input
                id="consumerName"
                type="text"
                [(ngModel)]="config.consumerName"
                placeholder="consumer-1"
                class="form-input"
                readonly>
            </div>
          </div>
          <div class="config-section">
            <h4 class="subsection-title">DLQ Parameters</h4>
            <div class="form-group highlight">
              <label for="maxDeliveries">
                Max Retry (Max Deliveries) - Editable
                <span class="label-hint">Messages will be sent to DLQ after this many delivery attempts</span>
              </label>
              <input
                id="maxDeliveries"
                type="number"
                [(ngModel)]="config.maxDeliveries"
                min="1"
                max="100"
                class="form-input editable">
              <div class="input-hint">Current value: {{ config.maxDeliveries }} attempts</div>
            </div>
            <div class="form-group">
              <label for="minIdleMs">
                Min Idle Time (ms)
                <span class="label-hint">Minimum time a message must be idle before reclaim</span>
              </label>
              <input
                id="minIdleMs"
                type="number"
                [(ngModel)]="config.minIdleMs"
                min="0"
                step="1000"
                class="form-input"
                readonly>
              <div class="input-hint">{{ config.minIdleMs / 1000 }} seconds</div>
            </div>
            <div class="form-group">
              <label for="count">
                Batch Size
                <span class="label-hint">Max messages to process per claim operation</span>
              </label>
              <input
                id="count"
                type="number"
                [(ngModel)]="config.count"
                min="1"
                max="1000"
                class="form-input"
                readonly>
            </div>
          </div>
          <div class="actions">
            <button
              class="btn btn-primary"
              (click)="saveConfig()"
              [disabled]="isSaving()">
              {{ isSaving() ? 'Saving...' : 'Save Max Retry' }}
            </button>
            <button
              class="btn btn-secondary"
              (click)="resetMaxRetry()">
              Reset Max Retry
            </button>
          </div>
          @if (message()) {
            <div class="message" [class.success]="isSuccess()" [class.error]="!isSuccess()">
              {{ message() }}
            </div>
          }
        </div>
      }
    </div>
    `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .dlq-config {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    /* Collapsed View */
    .collapsed-view {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .collapsed-view:hover {
      background: #f1f5f9;
      border-color: #cbd5e1;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    .collapsed-content {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .collapsed-label {
      font-size: 14px;
      font-weight: 500;
      color: #475569;
    }

    .collapsed-value {
      font-size: 18px;
      font-weight: 700;
      color: #3b82f6;
      min-width: 24px;
      text-align: center;
    }

    .expand-icon {
      font-size: 12px;
      color: #64748b;
      transition: transform 0.2s ease;
    }

    .collapse-icon {
      font-size: 12px;
      color: #64748b;
      transition: transform 0.2s ease;
    }

    /* Expanded View */
    .expanded-view {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      padding: 8px 0;
      border-bottom: 2px solid #e2e8f0;
    }

    .header-row:hover .section-title {
      color: #3b82f6;
    }

    .config-section {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .section-title {
      font-size: 16px;
      font-weight: 600;
      color: #1e293b;
      margin: 0;
      transition: color 0.2s ease;
    }

    .subsection-title {
      font-size: 14px;
      font-weight: 600;
      color: #475569;
      margin: 0 0 8px 0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .form-group.highlight {
      background: #eff6ff;
      padding: 12px;
      border-radius: 8px;
      border: 2px solid #3b82f6;
    }

    .form-group label {
      font-size: 14px;
      font-weight: 500;
      color: #334155;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .label-hint {
      font-size: 12px;
      font-weight: 400;
      color: #64748b;
      font-style: italic;
    }

    .form-input {
      padding: 10px 12px;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      font-size: 14px;
      transition: all 0.2s ease;
      background: #f8fafc;
    }

    .form-input[readonly] {
      background: #f1f5f9;
      color: #64748b;
      cursor: not-allowed;
      border-color: #e2e8f0;
    }

    .form-input.editable {
      background: white;
      border-color: #3b82f6;
      font-weight: 600;
    }

    .form-input.editable:focus {
      outline: none;
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
    }

    .form-input:disabled {
      background: #f1f5f9;
      cursor: not-allowed;
    }

    .input-hint {
      font-size: 12px;
      color: #64748b;
      margin-top: -2px;
    }

    .actions {
      display: flex;
      gap: 12px;
      padding-top: 8px;
    }

    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-primary {
      background: #3b82f6;
      color: white;
    }

    .btn-primary:hover:not(:disabled) {
      background: #2563eb;
      box-shadow: 0 2px 4px rgba(59, 130, 246, 0.3);
    }

    .btn-secondary {
      background: #e2e8f0;
      color: #334155;
    }

    .btn-secondary:hover {
      background: #cbd5e1;
    }

    .message {
      padding: 12px 16px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
    }

    .message.success {
      background: #dcfce7;
      color: #166534;
      border: 1px solid #86efac;
    }

    .message.error {
      background: #fee2e2;
      color: #991b1b;
      border: 1px solid #fca5a5;
    }
  `]
})
export class DlqConfigComponent {
  private http = inject(HttpClient);
  private apiUrl = 'http://localhost:8080/api/dlq';

  // Configuration state
  config: DLQConfig = {
    streamName: 'test-stream',
    dlqStreamName: 'test-stream:dlq',
    consumerGroup: 'test-group',
    consumerName: 'consumer-1',
    minIdleMs: 100,
    count: 100,
    maxDeliveries: 2
  };

  // UI state
  isSaving = signal(false);
  message = signal('');
  isSuccess = signal(false);
  isExpanded = signal(false);

  /**
   * Toggle expand/collapse state
   */
  toggleExpand(): void {
    this.isExpanded.set(!this.isExpanded());
  }

  /**
   * Save the configuration by calling the backend endpoint
   */
  saveConfig(): void {
    this.isSaving.set(true);
    this.message.set('');

    // Call the claim endpoint with the new configuration
    // This will use the new maxDeliveries value for future operations
    this.http.post(`${this.apiUrl}/config`, this.config).subscribe({
      next: () => {
        this.isSaving.set(false);
        this.isSuccess.set(true);
        this.message.set('Max Retry saved successfully! Set to ' + this.config.maxDeliveries + ' attempts');

        // Clear message after 5 seconds
        setTimeout(() => this.message.set(''), 5000);
      },
      error: (error) => {
        this.isSaving.set(false);
        this.isSuccess.set(false);
        this.message.set('Failed to save: ' + (error.error?.message || error.message));
        console.error('Error saving config:', error);
      }
    });
  }

  /**
   * Reset only maxRetry to default value
   */
  resetMaxRetry(): void {
    this.config.maxDeliveries = 2;
    this.message.set('Max Retry reset to default (2 attempts)');
    this.isSuccess.set(true);
    setTimeout(() => this.message.set(''), 3000);
  }
}


