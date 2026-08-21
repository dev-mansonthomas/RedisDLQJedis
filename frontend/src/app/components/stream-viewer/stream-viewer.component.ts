import { Component, Input, OnInit, OnDestroy, inject, ChangeDetectorRef, ChangeDetectionStrategy } from '@angular/core';

import { WebSocketService, DLQEvent } from '../../services/websocket.service';
import { RedisApiService } from '../../services/redis-api.service';
import { StreamRefreshService } from '../../services/stream-refresh.service';
import { Subscription } from 'rxjs';

export interface StreamMessage {
  id: string;
  fields: Record<string, string>;
  timestamp: string;
  isFlashingError?: boolean;  // For visual feedback on failed processing (red)
  isFlashingSuccess?: boolean;  // For visual feedback on successful processing (green)
  pendingDeletion?: boolean;  // Mark message for deletion after animation completes
  isNextToProcess?: boolean;  // Indicates this is the next message to be processed by consumer
  deliveryCount?: number;     // PEL delivery counter (only when the entry is pending)
  isReleased?: boolean;       // XNACK-released: pending but unowned (consumer empty / idle -1)
  isPoison?: boolean;         // XNACK FATAL: counter at Long.MAX (rendered as ∞ — JSON rounds it)
}

/**
 * Reusable component to display Redis Stream messages with real-time updates via WebSocket.
 * 
 * Features:
 * - Displays messages in reverse chronological order (oldest unread at bottom)
 * - Real-time updates via WebSocket
 * - Pagination support
 * - Shows stream name header
 * - "More messages..." indicator when applicable
 */
@Component({
  selector: 'app-stream-viewer',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stream-viewer" [style.height.px]="containerHeight">
      <div class="stream-header">
        <h3 class="stream-name">{{ stream }}</h3>
        <div class="connection-status" [class.connected]="isConnected" [class.disconnected]="!isConnected">
          <span class="status-dot"></span>
          <span class="status-text">{{ isConnected ? 'Connected' : 'Disconnected' }}</span>
        </div>
      </div>
    
      <div class="messages-container">
        <!-- "More messages..." indicator at top -->
        @if (hasMoreMessages) {
          <div class="more-messages">
            ... {{ totalMessages - pageSize }} more messages ...
          </div>
        }
    
        <!-- Messages as compact cells -->
        @for (message of displayedMessages; track message) {
          <div
            class="message-cell"
            [style.flex]="'0 0 ' + messageHeight + 'px'"
            [class.flash-error]="message.isFlashingError"
            [class.flash-success]="message.isFlashingSuccess"
            [class.next-to-process]="message.isNextToProcess">
            @if (showNextIndicator && message.isNextToProcess) {
              <span class="next-indicator">➡️</span>
            }
            <div class="message-header">
              <span class="message-id">{{ message.id }}</span>
              <span class="badges">
                @if (message.isPoison) {
                  <span class="badge poison" title="XNACK FATAL: delivery counter at max — swept to DLQ on next poll">∞ poison</span>
                }
                @if (!message.isPoison && message.deliveryCount !== undefined) {
                  <span class="badge deliveries" title="PEL delivery count">{{ message.deliveryCount }}×</span>
                }
                @if (message.isReleased) {
                  <span class="badge released" title="XNACK-released: unowned, immediately re-claimable">released</span>
                }
              </span>
            </div>
            <div class="message-content">
              @for (field of getFields(message.fields); track field) {
                <div class="field-row">
                  <span class="field-key">{{ field.key }}</span>
                  <span class="field-value">{{ field.value }}</span>
                </div>
              }
            </div>
          </div>
        }
    
        <!-- Empty state -->
        @if (displayedMessages.length === 0 && !isLoading) {
          <div class="empty-state">
            No messages in stream
          </div>
        }
    
        <!-- Loading state -->
        @if (isLoading) {
          <div class="loading-state">
            Loading messages...
          </div>
        }
      </div>
    
      <div class="stream-footer">
        <span class="message-count">{{ displayedMessages.length }} of {{ totalMessages }} messages</span>
      </div>
    </div>
    `,
  styles: [`
    .stream-viewer {
      background: white;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      min-height: 0;
    }

    .stream-header {
      padding: 12px 16px;
      background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
      border-bottom: 1px solid #e2e8f0;
      display: flex;
      flex-shrink: 0;
      justify-content: space-between;
      align-items: center;
    }

    .stream-name {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: #1e293b;
    }

    .connection-status {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 10px;
      background: #f1f5f9;
    }

    .connection-status.connected {
      background: #dcfce7;
      color: #166534;
    }

    .connection-status.disconnected {
      background: #fee2e2;
      color: #991b1b;
    }

    .status-dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
    }

    .status-text {
      font-weight: 500;
    }

    .messages-container {
      flex: 1 1 auto;
      min-height: 0;     
      overflow-y: scroll;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px;
      padding-left: 36px;  /* Space for next indicator arrow */
      background: #f8fafc;
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
      

    .more-messages {
      text-align: center;
      padding: 8px;
      font-size: 12px;
      color: #64748b;
      font-style: italic;
      background: #f1f5f9;
      border-radius: 4px;
    }

    .message-cell {
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 4px;
      overflow: hidden;
      transition: box-shadow 0.15s ease;
      position: relative;
      flex: 0 0 125px; 
      display:flex;
      flex-direction: column;
    }

    .message-cell:hover {
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    .message-cell.next-to-process {
      border-left: 3px solid #3b82f6;
    }

    .next-indicator {
      position: absolute;
      left: -28px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 20px;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% {
        opacity: 1;
      }
      50% {
        opacity: 0.5;
      }
    }

    .message-cell.flash-error {
      animation: flashRed 0.5s ease-in-out 4;
    }

    @keyframes flashRed {
      0%, 100% {
        background: white;
        border-color: #e2e8f0;
        transform: scale(1);
      }
      50% {
        background: #dc2626;        /* Rouge vif */
        border-color: #dc2626;
        color: white;
        box-shadow: 0 0 20px rgba(220, 38, 38, 0.8);
        transform: scale(1.02);
      }
    }

    .message-cell.flash-error .message-id,
    .message-cell.flash-error .field-key,
    .message-cell.flash-error .field-value {
      animation: textFlashRed 0.5s ease-in-out 4;
    }

    @keyframes textFlashRed {
      0%, 100% {
        color: inherit;
      }
      50% {
        color: white;
      }
    }

    .message-cell.flash-success {
      animation: flashGreen 0.5s ease-in-out 4;  /* Même vitesse que flash-error */
    }

    @keyframes flashGreen {
      0%, 100% {
        background: white;
        border-color: #e2e8f0;
        transform: scale(1);
      }
      50% {
        background: #16a34a;        /* Vert vif */
        border-color: #16a34a;
        color: white;
        box-shadow: 0 0 20px rgba(22, 163, 74, 0.8);
        transform: scale(1.02);
      }
    }

    .message-cell.flash-success .message-id,
    .message-cell.flash-success .field-key,
    .message-cell.flash-success .field-value {
      animation: textFlashGreen 0.5s ease-in-out 4;  /* Même vitesse que flash-error */
    }

    @keyframes textFlashGreen {
      0%, 100% {
        color: inherit;
      }
      50% {
        color: white;
      }
    }

    .message-header {
      background: #f8fafc;
      padding: 6px 10px;
      border-bottom: 1px solid #e2e8f0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }

    .badges {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }

    .badge {
      font-size: 9px;
      font-weight: 700;
      padding: 1px 6px;
      border-radius: 8px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .badge.deliveries {
      background: #e0e7ff;
      color: #3730a3;
    }

    .badge.released {
      background: #f1f5f9;
      color: #475569;
      border: 1px dashed #94a3b8;
    }

    .badge.poison {
      background: #450a0a;
      color: #fecaca;
    }

    .message-id {
      font-family: 'Courier New', monospace;
      font-size: 10px;
      color: #64748b;
      font-weight: 500;
    }

    .message-content {
      padding: 8px 10px;
      font-size: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      overflow:hidden;
    }

    .field-row {
      display: grid;
      grid-template-columns: 100px 1fr;
      gap: 12px;
      align-items: baseline;
    }

    .field-key {
      font-weight: 600;
      color: #64748b;
      font-size: 11px;
      text-align: right;
      padding-right: 8px;
      border-right: 2px solid #e2e8f0;
    }

    .field-value {
      color: #1e293b;
      font-weight: 500;
      font-size: 12px;
      word-break: break-word;
    }

    .empty-state, .loading-state {
      text-align: center;
      color: #94a3b8;
      font-size: 13px;
      padding: 40px 20px;
      font-style: italic;
    }

    .stream-footer {
      padding: 8px 12px;
      background: #f8fafc;
      border-top: 1px solid #e2e8f0;
      display: flex;
      justify-content: center;
      align-items: center;
      flex-shrink: 0;
    }

    .message-count {
      font-size: 11px;
      color: #64748b;
      font-weight: 500;
    }
  `]
})
export class StreamViewerComponent implements OnInit, OnDestroy {
  @Input() stream = '';
  @Input() group = '';
  @Input() consumer = '';
  @Input() pageSize = 10;
  @Input() showNextIndicator = false;  // Show indicator for next message to process
  @Input() containerHeight = 275;  // Height in pixels (default: 275px)
  @Input() messageHeight = 125;  // Height of each message cell in pixels (default: 125px)

  private wsService = inject(WebSocketService);
  private apiService = inject(RedisApiService);
  private refreshService = inject(StreamRefreshService);
  private cdr = inject(ChangeDetectorRef);
  private eventSubscription?: Subscription;
  private statusSubscription?: Subscription;
  private refreshSubscription?: Subscription;

  displayedMessages: StreamMessage[] = [];
  totalMessages = 0;
  hasMoreMessages = false;
  isConnected = false;
  isLoading = true;

  ngOnInit(): void {
    // Connect if stream name is provided
    // For simple streams (no consumer groups), group and consumer are optional
    if (this.stream) {
      this.loadInitialData();
      this.connectWebSocket();
      this.subscribeToRefresh();
    } else {
      console.warn('StreamViewerComponent: Missing required parameter (stream)');
      this.isLoading = false;
    }
  }

  ngOnDestroy(): void {
    this.eventSubscription?.unsubscribe();
    this.statusSubscription?.unsubscribe();
    this.refreshSubscription?.unsubscribe();
  }

  /**
   * Subscribe to refresh events from StreamRefreshService.
   */
  private subscribeToRefresh(): void {
    this.refreshSubscription = this.refreshService.refresh$.subscribe(() => {
      console.log(`StreamViewer [${this.stream}]: Received refresh event, reloading data`);
      this.loadInitialData();
    });
  }

  /**
   * Merge PEL info (delivery count, released/poison state) into the displayed entries.
   * Only meaningful when a consumer group is set; entries not in the PEL get their
   * pending markers cleared. Poison detection is threshold-based: Long.MAX arrives
   * rounded through JSON, so equality would never match.
   */
  private refreshPendingInfo(): void {
    if (!this.group) {
      return;
    }
    this.apiService.getPendingMessages(this.stream, this.group, this.pageSize).subscribe({
      next: (response) => {
        if (!response.success || !response.messages) {
          return;
        }
        const byId = new Map(response.messages.map(m => [m.id, m]));
        this.displayedMessages.forEach(msg => {
          const pel = byId.get(msg.id);
          if (pel) {
            msg.isPoison = (pel.deliveryCount ?? 0) >= Number.MAX_SAFE_INTEGER;
            msg.deliveryCount = pel.deliveryCount;
            msg.isReleased = pel.consumer === '' || (pel.idleMs ?? 0) < 0;
          } else {
            msg.deliveryCount = undefined;
            msg.isReleased = false;
            msg.isPoison = false;
          }
        });
        this.cdr.markForCheck();
      },
      error: (error) => {
        console.warn(`StreamViewer [${this.stream}]: Failed to load pending info`, error);
      }
    });
  }

  private loadInitialData(): void {
    this.isLoading = true;

    console.log(`StreamViewer [${this.stream}]: Loading initial data (pageSize: ${this.pageSize})`);

    // Load existing messages from the stream
    this.apiService.getMessages(this.stream, this.pageSize).subscribe({
      next: (response) => {
        console.log(`StreamViewer [${this.stream}]: Received response:`, response);

        if (response.success && response.messages) {
          // Convert API response to StreamMessage format
          this.displayedMessages = response.messages.map(msg => ({
            id: msg.id,
            fields: msg.fields,
            timestamp: new Date().toISOString() // Timestamp not provided by API
          }));

          this.totalMessages = response.count;
          this.hasMoreMessages = false; // We don't know total count yet

          console.log(`StreamViewer [${this.stream}]: Loaded ${this.displayedMessages.length} messages`, this.displayedMessages);

          // Update next indicator after loading messages
          this.updateNextIndicator();
          this.refreshPendingInfo();
        } else {
          console.warn(`StreamViewer [${this.stream}]: Response not successful or no messages`, response);
        }
        this.isLoading = false;
        this.cdr.markForCheck(); // Force change detection
      },
      error: (error) => {
        console.error(`StreamViewer [${this.stream}]: Failed to load messages`, error);
        console.error(`StreamViewer [${this.stream}]: Error details:`, {
          status: error.status,
          statusText: error.statusText,
          message: error.message,
          url: error.url
        });
        this.isLoading = false;
      }
    });
  }

  private connectWebSocket(): void {
    // Connect to WebSocket (or get existing connection)
    this.wsService.connect();

    // Subscribe to connection status
    this.statusSubscription = this.wsService.getConnectionStatus().subscribe(
      status => {
        console.log(`StreamViewer [${this.stream}]: Connection status changed to ${status}`);
        this.isConnected = status;
        this.cdr.markForCheck(); // Force change detection
      }
    );

    // Subscribe to events
    this.eventSubscription = this.wsService.getEvents().subscribe(
      event => this.handleWebSocketEvent(event)
    );

    // Check if already connected
    if (this.wsService.isConnected()) {
      this.isConnected = true;
    }
  }

  private handleWebSocketEvent(event: DLQEvent): void {
    console.log(`StreamViewer [${this.stream}]: Received WebSocket event:`, event);

    // Filter events for this stream
    if (event.streamName !== this.stream) {
      console.log(`StreamViewer [${this.stream}]: Event ignored (different stream: ${event.streamName})`);
      return;
    }

    // Handle MESSAGE_PROCESSED (flash effect for successful processing)
    if (event.eventType === 'MESSAGE_PROCESSED' && event.messageId) {
      console.log(`StreamViewer [${this.stream}]: ✅ MESSAGE_PROCESSED received!`);
      this.flashMessageSuccess(event.messageId);

      // Move indicator to next message in the list (simple, no backend call)
      this.moveIndicatorToNextMessage(event.messageId);
      // Don't return - continue processing other events
    }

    // Handle message deletion (ACK)
    if (event.eventType === 'MESSAGE_DELETED' && event.messageId) {
      console.log(`StreamViewer [${this.stream}]: MESSAGE_DELETED received for:`, event.messageId);

      // Check if message is currently flashing (success animation)
      const message = this.displayedMessages.find(m => m.id === event.messageId);
      if (message && message.isFlashingSuccess) {
        console.log(`StreamViewer [${this.stream}]: Message is flashing, marking for deletion after animation`);
        message.pendingDeletion = true;
        // Don't delete now - flashMessageSuccess() will handle it after animation
        return;
      }

      // If not flashing, delete immediately
      console.log(`StreamViewer [${this.stream}]: Deleting message immediately:`, event.messageId);
      const initialLength = this.displayedMessages.length;
      this.displayedMessages = this.displayedMessages.filter(msg => msg.id !== event.messageId);

      if (this.displayedMessages.length < initialLength) {
        this.totalMessages--;
        console.log(`StreamViewer [${this.stream}]: Message deleted. New count: ${this.totalMessages}`);
      }

      // Update next indicator after deletion
      this.updateNextIndicator();
      this.cdr.markForCheck();
      return;
    }

    // Handle MESSAGE_RECLAIMED (flash effect for failed processing)
    if (event.eventType === 'MESSAGE_RECLAIMED' && event.messageId) {
      console.log(`StreamViewer [${this.stream}]: ⚠️ MESSAGE_RECLAIMED received!`);
      this.flashMessage(event.messageId);

      // Move indicator to next message in the list (simple, no backend call)
      this.moveIndicatorToNextMessage(event.messageId);
      this.refreshPendingInfo();
      return;
    }

    // Handle MESSAGE_NACKED (XNACK, Redis 8.8+): flash + refresh released/poison badges
    if (event.eventType === 'MESSAGE_NACKED' && event.messageId) {
      console.log(`StreamViewer [${this.stream}]: ⚡ MESSAGE_NACKED received (${event.details})`);
      this.flashMessage(event.messageId);
      this.refreshPendingInfo();
      return;
    }

    // Ignore other processing events (not new messages)
    if (event.eventType === 'INFO' || event.eventType === 'ERROR') {
      console.log(`StreamViewer [${this.stream}]: Event ignored (processing event: ${event.eventType})`);
      return;
    }

    // Add new message to the list (only for MESSAGE_PRODUCED events)
    if (event.eventType === 'MESSAGE_PRODUCED' && event.messageId && event.payload) {
      const newMessage: StreamMessage = {
        id: event.messageId,
        fields: event.payload,
        timestamp: event.timestamp || new Date().toISOString()
      };

      console.log(`StreamViewer [${this.stream}]: Adding new message:`, newMessage);

      // Add to beginning (newest first)
      this.displayedMessages.unshift(newMessage);
      this.totalMessages++;

      // Keep only pageSize messages
      if (this.displayedMessages.length > this.pageSize) {
        this.displayedMessages = this.displayedMessages.slice(0, this.pageSize);
        this.hasMoreMessages = true;
      }

      // Update next indicator after adding new message
      this.updateNextIndicator();

      this.cdr.markForCheck(); // Force change detection
    }
  }

  getFields(fields: Record<string, string>): {key: string; value: string}[] {
    // Prioritize paymentId and amount to appear first
    const priorityOrder = ['paymentId', 'amount'];
    const entries = Object.entries(fields);

    return entries.sort(([keyA], [keyB]) => {
      const indexA = priorityOrder.indexOf(keyA);
      const indexB = priorityOrder.indexOf(keyB);

      // If both are priority fields, sort by priority order
      if (indexA !== -1 && indexB !== -1) return indexA - indexB;
      // Priority fields come first
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;
      // Other fields keep original order
      return 0;
    }).map(([key, value]) => ({ key, value }));
  }

  /**
   * Update the "next to process" indicator.
   * Fetches the next pending message ID from Redis and marks it in the UI.
   */
  private updateNextIndicator(): void {
    if (!this.showNextIndicator || this.displayedMessages.length === 0) {
      console.log(`StreamViewer [${this.stream}]: updateNextIndicator skipped (showNextIndicator=${this.showNextIndicator}, messages=${this.displayedMessages.length})`);
      return;
    }

    console.log(`StreamViewer [${this.stream}]: updateNextIndicator called, clearing all indicators`);
    // Clear all indicators first
    this.displayedMessages.forEach(msg => msg.isNextToProcess = false);

    // Fetch next pending message ID from Redis
    console.log(`StreamViewer [${this.stream}]: Fetching next pending message from Redis...`);
    this.apiService.getNextMessage(this.stream, this.group).subscribe({
      next: (response) => {
        console.log(`StreamViewer [${this.stream}]: getNextMessage response:`, response);
        if (response.success && response.nextMessageId) {
          console.log(`StreamViewer [${this.stream}]: Next pending message from Redis: ${response.nextMessageId}`);
          console.log(`StreamViewer [${this.stream}]: Current displayed messages:`, this.displayedMessages.map(m => m.id));

          // Find and mark the message
          const nextMessage = this.displayedMessages.find(msg => msg.id === response.nextMessageId);
          if (nextMessage) {
            nextMessage.isNextToProcess = true;
            console.log(`StreamViewer [${this.stream}]: ✅ Marked message ${response.nextMessageId} as next to process`);
            this.cdr.markForCheck();
          } else {
            console.warn(`StreamViewer [${this.stream}]: ❌ Next message ${response.nextMessageId} not found in displayed messages`);
            console.warn(`StreamViewer [${this.stream}]: Available message IDs:`, this.displayedMessages.map(m => m.id));
          }
        } else {
          console.log(`StreamViewer [${this.stream}]: No pending messages (nextMessageId=${response.nextMessageId})`);
        }
      },
      error: (error) => {
        console.error(`StreamViewer [${this.stream}]: Error fetching next message:`, error);
      }
    });
  }

  /**
   * Put indicator on the message that was just processed.
   * Simple: find the message and put the indicator on it.
   */
  private moveIndicatorToNextMessage(currentMessageId: string): void {
    console.log(`StreamViewer [${this.stream}]: Putting indicator on message ${currentMessageId}`);

    // Clear all indicators first
    this.displayedMessages.forEach(msg => msg.isNextToProcess = false);

    // Find the message that was just processed
    const message = this.displayedMessages.find(msg => msg.id === currentMessageId);

    if (!message) {
      console.warn(`StreamViewer [${this.stream}]: Message ${currentMessageId} not found`);
      return;
    }

    // Put indicator on this message
    message.isNextToProcess = true;
    console.log(`StreamViewer [${this.stream}]: ✅ Put indicator on message ${currentMessageId}`);
    this.cdr.markForCheck();
  }

  /**
   * Public method to test flash animation manually from browser console.
   * Usage: In console, find the component instance and call testFlash()
   */
  public testFlash(): void {
    if (this.displayedMessages.length > 0) {
      const firstMessageId = this.displayedMessages[0].id;
      console.log(`🧪 Testing flash on first message: ${firstMessageId}`);
      this.flashMessage(firstMessageId);
    } else {
      console.warn('No messages to flash');
    }
  }

  /**
   * Flash a message with red animation (for failed processing).
   * The animation lasts 2 seconds (4 flashes × 0.5s).
   */
  private flashMessage(messageId: string): void {
    console.log(`StreamViewer [${this.stream}]: Flashing message RED ${messageId}`);
    console.log(`StreamViewer [${this.stream}]: Current displayed messages:`, this.displayedMessages.map(m => m.id));

    // Find the message and set isFlashingError to true
    const message = this.displayedMessages.find(m => m.id === messageId);
    if (message) {
      console.log(`StreamViewer [${this.stream}]: Message found! Setting isFlashingError=true`);
      message.isFlashingError = true;
      this.cdr.markForCheck();

      // Remove the flash class after animation completes (2 seconds)
      setTimeout(() => {
        console.log(`StreamViewer [${this.stream}]: Removing red flash from message ${messageId}`);
        message.isFlashingError = false;
        this.cdr.markForCheck();
      }, 2000);
    } else {
      console.warn(`StreamViewer [${this.stream}]: Message ${messageId} not found for flashing`);
      console.warn(`StreamViewer [${this.stream}]: Available message IDs:`, this.displayedMessages.map(m => m.id));
    }
  }

  /**
   * Flash a message with green animation (for successful processing).
   * The animation lasts 2 seconds (4 flashes × 0.5s).
   * After animation, deletes the message if it was marked for deletion.
   */
  private flashMessageSuccess(messageId: string): void {
    console.log(`StreamViewer [${this.stream}]: Flashing message GREEN ${messageId}`);
    console.log(`StreamViewer [${this.stream}]: Current displayed messages:`, this.displayedMessages.map(m => m.id));

    // Find the message and set isFlashingSuccess to true
    const message = this.displayedMessages.find(m => m.id === messageId);
    if (message) {
      console.log(`StreamViewer [${this.stream}]: Message found! Setting isFlashingSuccess=true`);
      message.isFlashingSuccess = true;
      this.cdr.markForCheck();

      // Remove the flash class after animation completes (2 seconds)
      setTimeout(() => {
        console.log(`StreamViewer [${this.stream}]: Animation complete for message ${messageId}`);
        message.isFlashingSuccess = false;

        // If message was marked for deletion, delete it now
        if (message.pendingDeletion) {
          console.log(`StreamViewer [${this.stream}]: Deleting message after animation: ${messageId}`);
          const initialLength = this.displayedMessages.length;
          this.displayedMessages = this.displayedMessages.filter(msg => msg.id !== messageId);

          if (this.displayedMessages.length < initialLength) {
            this.totalMessages--;
            console.log(`StreamViewer [${this.stream}]: Message deleted after animation. New count: ${this.totalMessages}`);
          }

          // Update next indicator after deletion
          this.updateNextIndicator();
        }

        this.cdr.markForCheck();
      }, 2000);  // Même durée que flash-error
    } else {
      console.warn(`StreamViewer [${this.stream}]: Message ${messageId} not found for flashing`);
      console.warn(`StreamViewer [${this.stream}]: Available message IDs:`, this.displayedMessages.map(m => m.id));
    }
  }
}

