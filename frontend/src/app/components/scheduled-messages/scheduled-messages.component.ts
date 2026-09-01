import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef, ChangeDetectionStrategy } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { StreamViewerComponent } from '../stream-viewer/stream-viewer.component';
import { StreamRefreshService } from '../../services/stream-refresh.service';
import { MermaidDiagramComponent } from '../mermaid-diagram/mermaid-diagram.component';
import { DiagramDefinitionsService } from '../../services/diagram-definitions.service';
import { API_BASE } from '../../api.config';

interface ScheduledMessage {
  id: string;
  title: string;
  description: string;
  scheduledFor: number;
  createdAt: number;
}

@Component({
  selector: 'app-scheduled-messages',
  standalone: true,
  imports: [FormsModule, StreamViewerComponent, MermaidDiagramComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scheduled-messages-container">
      <div class="page-header">
        <h2>⏰ Scheduled / Delayed Messages</h2>
        <p class="description">
          Schedule messages to be delivered at a specific time. Uses Redis Sorted Set with score = execution timestamp.
        </p>
      </div>
    
      <!-- Controls Section -->
      <div class="controls-section">
        <div class="controls-row">
          <button class="btn btn-add" (click)="openAddModal()">
            ➕ Add Scheduled Message
          </button>
          <button class="btn btn-clear" (click)="clearAll()">
            🗑 Clear All
          </button>
          <div class="refresh-info">
            Auto-refresh: <strong>{{ refreshInterval / 1000 }}s</strong>
          </div>
        </div>
      </div>
    
      <!-- Two-column layout for pending and executed messages -->
      <div class="two-columns">
        <!-- Scheduled Messages List -->
        <div class="scheduled-section">
          <h3>📋 Pending Scheduled Messages ({{ messages.length }})</h3>
          @if (messages.length > 0) {
            <div class="messages-list messages-scroll">
              @for (msg of messages; track msg) {
                <div class="message-card" [class.due-soon]="dueSoonFlags.get(msg.id)">
                  <div class="message-header">
                    <span class="message-title">{{ msg.title }}</span>
                    <span class="message-countdown" [class.warning]="dueSoonFlags.get(msg.id)">
                      {{ countdowns.get(msg.id) || 'Loading...' }}
                    </span>
                  </div>
                  <div class="message-description">{{ msg.description }}</div>
                  <div class="message-footer">
                    <span class="scheduled-time">
                      📅 {{ formatDate(msg.scheduledFor) }}
                    </span>
                    <div class="message-actions">
                      <button class="btn-icon btn-edit" (click)="openEditModal(msg)" title="Edit">✏️</button>
                      <button class="btn-icon btn-delete" (click)="deleteMessage(msg.id)" title="Delete">🗑️</button>
                    </div>
                  </div>
                </div>
              }
            </div>
          }
          @if (messages.length === 0) {
            <div class="empty-state">
              <p>No scheduled messages. Click "Add Scheduled Message" to create one.</p>
            </div>
          }
        </div>
    
        <!-- Executed Messages Stream -->
        <div class="stream-section">
          <h3>✅ Executed Messages (reminders.v1)</h3>
          <app-stream-viewer
            [stream]="'reminders.v1'"
            [pageSize]="10"
            [containerHeight]="500"
            [messageHeight]="200">
          </app-stream-viewer>
        </div>
      </div>
    
      <!-- Add/Edit Modal -->
      @if (showModal) {
        <div class="modal-overlay" (click)="onOverlayClick($event)" role="button" tabindex="0" aria-label="Close dialog" (keydown.escape)="closeModal()" (keydown.enter)="closeModal()" (keydown.space)="closeModal()">
          <div class="modal-content">
            <h3>{{ editingMessage ? 'Edit' : 'Add' }} Scheduled Message</h3>
            <form (ngSubmit)="saveMessage()">
              <div class="form-group">
                <label for="title">Title</label>
                <input id="title" type="text" [(ngModel)]="formData.title" name="title" required>
              </div>
              <div class="form-group">
                <label for="description">Description</label>
                <textarea id="description" [(ngModel)]="formData.description" name="description" rows="3"></textarea>
              </div>
              <div class="form-group">
                <label for="scheduledFor">Scheduled For</label>
                <div class="datetime-row">
                  <input id="scheduledFor" type="datetime-local" [(ngModel)]="formData.scheduledForInput"
                    name="scheduledFor" required [min]="minDateTime" class="datetime-input">
                  <div class="seconds-input">
                    <label for="seconds">Sec</label>
                    <input id="seconds" type="number" [(ngModel)]="formData.seconds" name="seconds"
                      min="0" max="59" placeholder="00">
                  </div>
                </div>
              </div>
              @if (formError) {
                <div class="form-error">{{ formError }}</div>
              }
              <div class="modal-actions">
                <button type="button" class="btn btn-cancel" (click)="closeModal()">Cancel</button>
                <button type="submit" class="btn btn-save">{{ editingMessage ? 'Update' : 'Schedule' }}</button>
              </div>
            </form>
          </div>
        </div>
      }
    
      <!-- Architecture Diagram -->
      <app-mermaid-diagram
        title="View Architecture & Sequence Diagrams"
        [architectureDiagram]="diagrams.scheduledMessages.architecture"
        [sequenceDiagram]="diagrams.scheduledMessages.sequence">
      </app-mermaid-diagram>
    
      <!-- Info Section -->
      <div class="info-box">
        <div class="info-header">
          <span class="info-icon">ℹ️</span>
          <h3>How Scheduled Messages Works</h3>
        </div>
        <div class="info-content">
          <div class="info-section">
            <h4>📝 Scheduling a Message</h4>
            <ol>
              <li><strong>User creates message</strong> with title, description, and execution time</li>
              <li><strong>Payload stored</strong> in Redis Hash: <code>scheduled:message:&lt;id&gt;</code></li>
              <li><strong>Added to Sorted Set</strong>: <code>ZADD scheduled.messages &lt;epoch_ms&gt; message:&lt;id&gt;</code></li>
              <li><strong>Score = execution timestamp</strong> enables efficient range queries</li>
            </ol>
          </div>
          <div class="info-section">
            <h4>⏱️ Scheduler (Virtual Thread)</h4>
            <ol>
              <li><strong>Polls every 500ms</strong> for due messages</li>
              <li><strong>Query</strong>: <code>ZRANGEBYSCORE scheduled.messages 0 &lt;now&gt; LIMIT 0 10</code></li>
              <li><strong>For each due message</strong>:
              <ul>
                <li>Read payload from Hash (<code>HGETALL</code>)</li>
                <li>Publish to <code>reminders.v1</code> stream (<code>XADD</code>)</li>
                <li>Remove from Sorted Set (<code>ZREM</code>) + delete Hash</li>
              </ul>
            </li>
          </ol>
        </div>
        <div class="info-section">
          <h4>🔧 Technical Details</h4>
          <ul>
            <li><strong>Sorted Set</strong>: <code>scheduled.messages</code> - efficient time-based queries O(log N)</li>
            <li><strong>Hash per message</strong>: <code>scheduled:message:&lt;id&gt;</code> - stores full payload</li>
            <li><strong>Stream</strong>: <code>reminders.v1</code> - executed messages for downstream processing</li>
            <li><strong>Virtual Thread</strong>: Java 21 lightweight thread for non-blocking scheduler</li>
          </ul>
        </div>
        <div class="info-section">
          <h4>💡 Use Cases</h4>
          <ul>
            <li><strong>Payment reminders</strong>: Send reminder N days before due date</li>
            <li><strong>Order expiration</strong>: Cancel unpaid orders after X hours</li>
            <li><strong>Retry with backoff</strong>: Schedule retry after exponential delay</li>
            <li><strong>Welcome sequences</strong>: Send onboarding emails at T+1h, T+24h, T+72h</li>
          </ul>
        </div>
      </div>
    </div>
    </div>
    `,
  styles: [`
    .scheduled-messages-container { padding: 20px; max-width: 1400px; margin: 0 auto; }
    .page-header { margin-bottom: 24px; }
    .page-header h2 { margin: 0 0 8px 0; color: #1e293b; }
    .description { color: #64748b; margin: 0; }

    .controls-section { background: white; border-radius: 8px; padding: 16px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .controls-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .refresh-info { margin-left: auto; color: #64748b; font-size: 14px; }

    .btn { padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; transition: all 0.2s; }
    .btn-add { background: #10b981; color: white; }
    .btn-add:hover { background: #059669; }
    .btn-clear { background: #ef4444; color: white; }
    .btn-clear:hover { background: #dc2626; }
    .btn-cancel { background: #6b7280; color: white; }
    .btn-save { background: #3b82f6; color: white; }
    .btn-save:hover { background: #2563eb; }

    .two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 24px; }
    .scheduled-section, .stream-section { background: white; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .scheduled-section h3, .stream-section h3 { margin: 0 0 16px 0; color: #1e293b; }

    .messages-list { display: flex; flex-direction: column; gap: 12px; }
    .messages-scroll { max-height: 500px; overflow-y: auto; }
    .message-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; transition: all 0.2s; }
    .message-card:hover { border-color: #3b82f6; }
    .message-card.due-soon { background: #fef3c7; border-color: #f59e0b; }
    .message-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .message-title { font-weight: 600; color: #1e293b; font-size: 16px; }
    .message-countdown { font-size: 14px; color: #3b82f6; font-weight: 500; padding: 4px 8px; background: #eff6ff; border-radius: 4px; }
    .message-countdown.warning { color: #d97706; background: #fef3c7; }
    .message-description { color: #64748b; font-size: 14px; margin-bottom: 12px; }
    .message-footer { display: flex; justify-content: space-between; align-items: center; }
    .scheduled-time { font-size: 13px; color: #64748b; }
    .message-actions { display: flex; gap: 8px; }
    .btn-icon { background: none; border: none; cursor: pointer; font-size: 16px; padding: 4px 8px; border-radius: 4px; transition: background 0.2s; }
    .btn-icon:hover { background: #e2e8f0; }

    .empty-state { text-align: center; padding: 40px; color: #64748b; }

    .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
    .modal-content { background: white; border-radius: 12px; padding: 24px; width: 100%; max-width: 480px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); }
    .modal-content h3 { margin: 0 0 20px 0; color: #1e293b; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; margin-bottom: 6px; font-weight: 500; color: #374151; }
    .form-group input, .form-group textarea { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
    .form-group input:focus, .form-group textarea:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
    .datetime-row { display: flex; gap: 12px; align-items: flex-end; }
    .datetime-input { flex: 1; }
    .seconds-input { display: flex; flex-direction: column; width: 70px; }
    .seconds-input label { font-size: 12px; color: #6b7280; margin-bottom: 4px; }
    .seconds-input input { width: 100%; text-align: center; }
    .form-error { color: #ef4444; font-size: 14px; margin-bottom: 16px; padding: 10px; background: #fef2f2; border-radius: 6px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px; }

    .info-box { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 20px; margin-top: 24px; }
    .info-header { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .info-header h3 { margin: 0; color: #0369a1; }
    .info-icon { font-size: 24px; }
    .info-content { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
    .info-section h4 { margin: 0 0 12px 0; color: #0369a1; font-size: 15px; }
    .info-section ol, .info-section ul { margin: 0; padding-left: 20px; color: #334155; font-size: 14px; line-height: 1.7; }
    .info-section code { background: #e0f2fe; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  `]
})
export class ScheduledMessagesComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private refreshService = inject(StreamRefreshService);
  diagrams = inject(DiagramDefinitionsService);
  private apiUrl = `${API_BASE}/scheduled-messages`;

  messages: ScheduledMessage[] = [];
  countdowns = new Map<string, string>();
  dueSoonFlags = new Map<string, boolean>();
  showModal = false;
  editingMessage: ScheduledMessage | null = null;
  formData = { title: '', description: '', scheduledForInput: '', seconds: 0 };
  formError = '';
  minDateTime = '';
  refreshInterval = 500;

  private refreshIntervalId?: number;
  private countdownIntervalId?: number;
  private cdr = inject(ChangeDetectorRef);

  ngOnInit(): void {
    this.updateMinDateTime();
    this.loadMessages();

    // Auto-refresh messages list
    this.refreshIntervalId = window.setInterval(() => {
      this.loadMessages();
    }, this.refreshInterval);

    // Update countdown every second
    this.countdownIntervalId = window.setInterval(() => {
      this.updateCountdowns();
      this.updateMinDateTime();
      this.cdr.markForCheck();
    }, 1000);
  }

  private updateCountdowns(): void {
    const now = Date.now();
    for (const msg of this.messages) {
      this.countdowns.set(msg.id, this.calculateCountdown(msg.scheduledFor, now));
      this.dueSoonFlags.set(msg.id, msg.scheduledFor - now < 60000);
    }
  }

  private calculateCountdown(scheduledFor: number, now: number): string {
    const diff = scheduledFor - now;
    if (diff <= 0) return 'Executing...';

    const seconds = Math.floor(diff / 1000) % 60;
    const minutes = Math.floor(diff / 60000) % 60;
    const hours = Math.floor(diff / 3600000);

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  ngOnDestroy(): void {
    if (this.refreshIntervalId) {
      clearInterval(this.refreshIntervalId);
    }
    if (this.countdownIntervalId) {
      clearInterval(this.countdownIntervalId);
    }
  }

  updateMinDateTime(): void {
    const now = new Date();
    now.setSeconds(0, 0);
    this.minDateTime = this.toLocalDateTimeString(now);
  }

  loadMessages(): void {
    this.http.get<{ success: boolean; messages: ScheduledMessage[] }>(this.apiUrl).subscribe({
      next: (res) => {
        if (res.success) {
          this.messages = res.messages;
          this.updateCountdowns();
          this.cdr.markForCheck();
        }
      },
      error: (err) => console.error('Failed to load messages', err)
    });
  }

  openAddModal(): void {
    this.editingMessage = null;
    this.formError = '';
    const defaultTime = new Date(Date.now() + 60000); // +1 minute
    this.formData = {
      title: 'New reminder',
      description: 'This is a scheduled reminder',
      scheduledForInput: this.formatDateTimeLocal(defaultTime),
      seconds: defaultTime.getSeconds()
    };
    this.showModal = true;
  }

  openEditModal(msg: ScheduledMessage): void {
    this.editingMessage = msg;
    this.formError = '';
    const date = new Date(msg.scheduledFor);
    this.formData = {
      title: msg.title,
      description: msg.description,
      scheduledForInput: this.formatDateTimeLocal(date),
      seconds: date.getSeconds()
    };
    this.showModal = true;
  }

  /**
   * Closes only when the backdrop itself is clicked. Checking the target here is what lets the
   * inner card drop its `$event.stopPropagation()` click sink -- a handler that existed only to
   * cancel this one, and that no keyboard user could ever reach.
   */
  onOverlayClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.closeModal();
    }
  }

  closeModal(): void {
    this.showModal = false;
    this.editingMessage = null;
    this.formError = '';
  }

  saveMessage(): void {
    // Parse datetime-local value (format: YYYY-MM-DDTHH:mm)
    // datetime-local doesn't include timezone, so we parse it manually as local time
    const [datePart, timePart] = this.formData.scheduledForInput.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hours, minutes] = timePart.split(':').map(Number);
    const seconds = Math.min(59, Math.max(0, this.formData.seconds || 0));

    // Create date in local timezone
    const baseDate = new Date(year, month - 1, day, hours, minutes, seconds);
    const scheduledFor = baseDate.getTime();

    // Validate: must be in the future
    if (scheduledFor <= Date.now()) {
      this.formError = 'Scheduled time must be in the future. Please select a later time.';
      return;
    }

    const payload = {
      title: this.formData.title,
      description: this.formData.description,
      scheduledFor
    };

    if (this.editingMessage) {
      // Update existing
      this.http.put(`${this.apiUrl}/${this.editingMessage.id}`, payload).subscribe({
        next: () => {
          this.closeModal();
          this.loadMessages();
          this.refreshService.triggerRefresh();
        },
        error: (err) => {
          this.formError = err.error?.error || 'Failed to update message';
        }
      });
    } else {
      // Create new
      this.http.post(this.apiUrl, payload).subscribe({
        next: () => {
          this.closeModal();
          this.loadMessages();
        },
        error: (err) => {
          this.formError = err.error?.error || 'Failed to schedule message';
        }
      });
    }
  }

  deleteMessage(id: string): void {
    if (confirm('Delete this scheduled message?')) {
      this.http.delete(`${this.apiUrl}/${id}`).subscribe({
        next: () => this.loadMessages(),
        error: (err) => console.error('Failed to delete', err)
      });
    }
  }

  clearAll(): void {
    if (confirm('Clear all scheduled messages and executed reminders?')) {
      this.http.delete(`${this.apiUrl}/clear`).subscribe({
        next: () => {
          this.loadMessages();
          this.refreshService.triggerRefresh();
        },
        error: (err) => console.error('Failed to clear', err)
      });
    }
  }

  // Helper methods
  formatDateTimeLocal(date: Date): string {
    return this.toLocalDateTimeString(date);
  }

  // Convert Date to local datetime string for datetime-local input (YYYY-MM-DDTHH:mm)
  private toLocalDateTimeString(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  formatDate(epochMs: number): string {
    return new Date(epochMs).toLocaleString();
  }
}

