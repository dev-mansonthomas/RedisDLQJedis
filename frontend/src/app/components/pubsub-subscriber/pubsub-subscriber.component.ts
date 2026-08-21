import { Component, Input, OnInit, OnDestroy, signal, inject, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WebSocketService } from '../../services/websocket.service';
import { Subscription } from 'rxjs';

export interface PubSubMessage {
  channel: string;
  payload: Record<string, string>;
  timestamp: string;
}

/**
 * Component for displaying Pub/Sub messages received in real-time.
 * 
 * This component subscribes to WebSocket events and displays messages
 * published to Redis Pub/Sub channels.
 */
@Component({
  selector: 'app-pubsub-subscriber',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="subscriber-container">
      <div class="subscriber-header">
        <div class="header-left">
          <h3 class="subscriber-title">{{ title }}</h3>
          <span class="connection-status" [class.connected]="isConnected()" [class.disconnected]="!isConnected()">
            <span class="status-dot"></span>
            {{ isConnected() ? 'WS Connected' : 'WS Disconnected' }}
          </span>
        </div>
        <span class="message-count">{{ messages().length }} messages</span>
      </div>

      <div class="messages-container">
        <div *ngIf="messages().length === 0" class="empty-state">
          <div class="empty-icon">📭</div>
          <p class="empty-text">No messages received yet</p>
          <p class="empty-hint">Waiting for published messages...</p>
        </div>

        <div *ngFor="let message of messages()" class="message-card">
          <div class="message-header">
            <span class="message-channel">{{ message.channel }}</span>
            <span class="message-time">{{ formatTime(message.timestamp) }}</span>
          </div>
          <div class="message-payload">
            <div *ngFor="let field of getFields(message.payload)" class="payload-field">
              <span class="field-key">{{ field.key }}:</span>
              <span class="field-value">{{ field.value }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [`
    .subscriber-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      overflow: hidden;
    }

    .subscriber-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }

    .header-left {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .subscriber-title {
      font-size: 16px;
      font-weight: 600;
      margin: 0;
    }

    .connection-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 500;
      padding: 3px 8px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.15);
      width: fit-content;
    }

    .connection-status.connected {
      background: rgba(34, 197, 94, 0.2);
    }

    .connection-status.disconnected {
      background: rgba(239, 68, 68, 0.2);
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: white;
    }

    .connection-status.connected .status-dot {
      background: #22c55e;
      animation: pulse 2s ease-in-out infinite;
    }

    .connection-status.disconnected .status-dot {
      background: #ef4444;
    }

    @keyframes pulse {
      0%, 100% {
        opacity: 1;
      }
      50% {
        opacity: 0.5;
      }
    }

    .message-count {
      font-size: 14px;
      background: rgba(255, 255, 255, 0.2);
      padding: 4px 12px;
      border-radius: 12px;
    }

    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      max-height: 275px; /* Show scrollbar after ~2 messages */
    }

    .messages-container::-webkit-scrollbar {
      width: 5px;     /* largeur fixe, toujours visible */
    }

    .messages-container::-webkit-scrollbar-thumb {
      background: #cbd5e1;
      border-radius: 4px;
    }

    .messages-container::-webkit-scrollbar-track {
      background: #f1f5f9;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #94a3b8;
    }

    .empty-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }

    .empty-text {
      font-size: 16px;
      font-weight: 500;
      margin: 0 0 8px 0;
    }

    .empty-hint {
      font-size: 14px;
      margin: 0;
    }

    .message-card {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 8px;
      transition: all 0.2s ease;
    }

    .message-card:hover {
      border-color: #cbd5e1;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
    }

    .message-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }

    .message-channel {
      font-size: 13px;
      font-weight: 600;
      color: #667eea;
    }

    .message-time {
      font-size: 12px;
      color: #64748b;
    }

    .message-payload {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .payload-field {
      font-size: 13px;
      font-family: 'Monaco', 'Menlo', monospace;
    }

    .field-key {
      color: #475569;
      font-weight: 500;
    }

    .field-value {
      color: #1e293b;
      margin-left: 8px;
    }
  `]
})
export class PubsubSubscriberComponent implements OnInit, OnDestroy {
  @Input() title: string = 'Subscriber';
  @Input() channel: string = 'fire-and-forget';

  private wsService = inject(WebSocketService);
  private subscription?: Subscription;
  private connectionSubscription?: Subscription;

  messages = signal<PubSubMessage[]>([]);
  isConnected = signal<boolean>(false);

  ngOnInit(): void {
    // Subscribe to WebSocket events
    this.subscription = this.wsService.getEvents().subscribe((event: any) => {
      if (event.eventType === 'MESSAGE_RECEIVED' && event.channel === this.channel) {
        this.messages.update(msgs => [{
          channel: event.channel,
          payload: event.payload,
          timestamp: event.timestamp
        }, ...msgs].slice(0, 50)); // Keep last 50 messages
      }
    });

    // Subscribe to connection status
    this.connectionSubscription = this.wsService.getConnectionStatus().subscribe((connected: boolean) => {
      this.isConnected.set(connected);
    });

    // Set initial connection status
    this.isConnected.set(this.wsService.isConnected());
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.connectionSubscription?.unsubscribe();
  }

  getFields(payload: Record<string, string>): Array<{key: string, value: string}> {
    return Object.entries(payload).map(([key, value]) => ({ key, value }));
  }

  formatTime(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  }
}

