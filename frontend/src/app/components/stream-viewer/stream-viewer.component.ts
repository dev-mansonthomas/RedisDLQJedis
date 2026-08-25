import { Component, Input, OnInit, OnDestroy, inject, ChangeDetectorRef, ChangeDetectionStrategy } from '@angular/core';

import { WebSocketService, DLQEvent, FailureKind } from '../../services/websocket.service';
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
  acked?: boolean;            // XACK'd by a worker. The entry STAYS in the stream (a stream is a log)
  failureKind?: FailureKind;  // How the last attempt failed, so the row can say *what* went wrong
  handled?: boolean;          // Attempted at least once, successfully or not — dimmed as "past"
}

/**
 * Button label for each failure action recorded in the DLQ entry's `failedVia` field.
 *
 * The tokens are what Redis stores (stable, and readable in redis-cli); the *labels* live here because
 * the buttons do. Putting UI wording in a Lua function would couple the sweep to the page's chrome.
 */
const ACTION_LABELS: Record<string, string> = {
  NO_ACK: 'Timeout',
  NACK_FAIL: 'Explicit fail',
  NACK_FATAL: 'Poison',
  NACK_SILENT: 'Release'
};


/** Header label + tooltip for each failure kind. */
const FAILURE_LABELS: Record<FailureKind, { label: string; title: string }> = {
  TIMEOUT: {
    label: '⏱ timeout',
    title: 'Simulated crash: no XACK was sent, so the entry stays owned by this consumer and is only '
      + 'redelivered once it has been idle for minIdle ms. The retry budget was charged.'
  },
  EXPLICIT_FAIL: {
    label: '⚡ explicit fail',
    title: 'XNACK FAIL: the consumer handed the message back immediately, without waiting out minIdle. '
      + 'The retry budget was charged all the same.'
  },
  // POISON and RELEASED already have their own badges, driven by the delivery counter — see the
  // template. They are listed so the map stays exhaustive over FailureKind.
  POISON: {
    label: '☠ poison',
    title: 'XNACK FATAL: delivery counter forced to max, swept to the DLQ on the next poll.'
  },
  RELEASED: {
    label: '↩ released',
    title: 'XNACK SILENT: returned untouched, retry budget refunded.'
  }
};

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
        <!-- Not a control — there is no pagination, and there never was: this is the one line that
             explains why a click can look like a no-op. The window holds the NEWEST pageSize entries
             (XREVRANGE) while the consumer group hands out the OLDEST first, so anything hidden here is
             processed before everything below it. Counted from what is on screen, not from pageSize:
             a trimmed row makes those two diverge. -->
        @if (hasMoreMessages) {
          <div class="more-messages"
               title="This viewer shows the newest entries (XREVRANGE). A consumer group delivers the oldest undelivered entry first, so these hidden ones are consumed before any row below — a click on Process can act on an entry you cannot see.">
            ↑ {{ totalMessages - displayedMessages.length }} older entries not shown — the oldest is
            processed first, so these go before the rows below
          </div>
        }
    
        <!-- Messages as compact cells -->
        @for (message of displayedMessages; track message) {
          <div
            class="message-cell"
            [style.flex]="'0 0 ' + messageHeight + 'px'"
            [class.flash-error]="message.isFlashingError"
            [class.flash-success]="message.isFlashingSuccess"
            [class.next-to-process]="message.isNextToProcess"
            [class.acked]="message.acked"
            [class.handled]="message.handled">
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
                @if (message.acked) {
                  <span class="badge acked" title="XACKed by a worker — the entry stays in the stream, because XACK is not XDEL">acked</span>
                }
                <!-- Only TIMEOUT / EXPLICIT_FAIL: POISON and RELEASED are already badged above from
                     the delivery counter, and badging them twice says nothing extra. -->
                @if (failureBadge(message); as failure) {
                  <span class="badge failure" [title]="failure.title">{{ failure.label }}</span>
                }
                <!-- How this entry ended up in the DLQ. Short by design: we are already looking at a
                     DLQ, so "fail" is a given — the full mechanism is one hover away. Written by the
                     sweep itself (read_claim_or_dlq), so it survives a reload and is not UI memory. -->
                @if (dlqOrigin(message); as origin) {
                  <span class="badge dlq-origin" [title]="origin.detail">{{ origin.label }}</span>
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

    .badge.failure {
      background: #fee2e2;
      color: #991b1b;
    }

    .badge.dlq-origin {
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #991b1b;
      font-weight: 700;
    }

    .badge.acked {
      background: #064e3b;
      color: #a7f3d0;
    }

    /* Handled entries stay visible on purpose — dimmed, not removed. Success or failure alike: what
       matters to a viewer is how far down the stream the demo has got. */
    .message-cell.acked,
    .message-cell.handled {
      opacity: 0.38;
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
  /**
   * Whether the window hides older entries — **derived**, never stored.
   *
   * It used to be a field, set to `false` on load ("we don't know the total yet") and only flipped
   * true when a live event pushed a row off the bottom. So a stream that was already longer than the
   * window when the page opened claimed to show all of it: `/per-key-serialized` read "5 of 5
   * messages" over a stream of 11, hiding the five oldest — the ones the consumer group processes
   * first. Deriving it cannot go stale.
   */
  get hasMoreMessages(): boolean {
    return this.totalMessages > this.displayedMessages.length;
  }
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
          if (msg.acked) {
            // An XACKed entry has left the PEL for good — a stream entry is never redelivered by `>`
            // once acknowledged. This poll can still race the ACK and read the old pending row, which
            // put a "2×" delivery badge next to the "acked" badge on the same card.
            msg.deliveryCount = undefined;
            msg.isReleased = false;
            msg.isPoison = false;
          } else if (pel) {
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

          // The stream's XLEN, not the size of the page: `count` is capped by pageSize, so a viewer
          // reading it as the total silently claims the window holds everything.
          this.totalMessages = response.streamLength ?? response.count;

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
      // Persist the "done" state, not just the flash: the operator needs to see how far down the
      // stream they have got. This event has exactly one emitter — the DLQ page's ACK path — and the
      // entry is XACKed immediately after it, so treating it as acknowledged is accurate.
      const processed = this.displayedMessages.find(m => m.id === event.messageId);
      if (processed) {
        processed.acked = true;
        processed.handled = true;
        processed.deliveryCount = undefined;  // no longer pending
        processed.isReleased = false;
        processed.failureKind = undefined;    // it succeeded in the end
        this.cdr.markForCheck();
      }
      this.flashMessageSuccess(event.messageId);

      // Move indicator to next message in the list (simple, no backend call)
      this.moveIndicatorToNextMessage(event.messageId);
      // Don't return - continue processing other events
    }

    // A worker finished a message. It is acknowledged, NOT deleted: the entry is still in the
    // stream, so the row stays and the total is untouched. Removing it here is what used to make the
    // viewer read "0 of 199 messages" while XLEN said 200.
    if (event.eventType === 'MESSAGE_ACKED' && event.messageId) {
      const acked = this.displayedMessages.find(m => m.id === event.messageId);
      if (acked) {
        acked.acked = true;
        acked.deliveryCount = undefined; // no longer pending
        acked.isReleased = false;
        acked.failureKind = undefined;   // it succeeded in the end; stale failure badges lie

        this.flashMessageSuccess(event.messageId);
        this.updateNextIndicator();
        this.cdr.markForCheck();
      }
      return;
    }

    // Handle a genuine disappearance from the stream (XDEL or trim), detected by StreamMonitorService.
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
      this.recordFailureKind(event);
      this.flashMessage(event.messageId);

      // Move indicator to next message in the list (simple, no backend call)
      this.moveIndicatorToNextMessage(event.messageId);
      this.refreshPendingInfo();
      return;
    }

    // Handle MESSAGE_NACKED (XNACK, Redis 8.8+): flash + refresh released/poison badges
    if (event.eventType === 'MESSAGE_NACKED' && event.messageId) {
      console.log(`StreamViewer [${this.stream}]: ⚡ MESSAGE_NACKED received (${event.details})`);
      this.recordFailureKind(event);
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
      }

      // Update next indicator after adding new message
      this.updateNextIndicator();

      this.cdr.markForCheck(); // Force change detection
    }
  }

  /**
   * The reason the sweep recorded on a dead-lettered entry, or `null`.
   *
   * Gated on `originalId` rather than on `reason` alone, and that is not belt-and-braces: this page's
   * own generated payloads carry a *business* `reason` field (`customer_request`, `fraud_detected`,
   * `payment_failed`). Keying off the field name labelled a perfectly healthy entry in the main stream
   * as if it had been dead-lettered — observed in a browser, 2026-08-25. Only the sweep writes
   * `originalId`.
   */
  dlqOrigin(message: StreamMessage): { label: string; detail: string } | null {
    const reason = message.fields['reason'];
    const originalId = message.fields['originalId'];
    if (!originalId || !reason) return null;
    // `failedVia` is optional (five other services sweep without it), so fall back to naming the fact
    // rather than the scenario.
    const scenario = this.scenarioLabel(message.fields['failedVia']);
    return {
      label: `⚠ ${scenario ?? 'Dead-lettered'}`,
      detail: `${reason} — originally ${originalId}`
    };
  }

  /**
   * Turns `NO_ACK,NO_ACK` into `Timeout ×2`, and a mixed run into `Timeout → Explicit fail`.
   *
   * Consecutive repeats are collapsed rather than listed: "×2" is how an operator counted the clicks,
   * whereas the same label twice reads like a rendering bug. Mixing really happens — a demo where the
   * timeout button is pressed once and the explicit-fail button once exhausts the same budget.
   */
  private scenarioLabel(failedVia: string | undefined): string | null {
    if (!failedVia) return null;
    const runs: { label: string; count: number }[] = [];
    for (const token of failedVia.split(',')) {
      const label = ACTION_LABELS[token] ?? token;
      const last = runs[runs.length - 1];
      if (last && last.label === label) {
        last.count++;
      } else {
        runs.push({ label, count: 1 });
      }
    }
    if (runs.length === 0) return null;
    return runs.map(r => (r.count > 1 ? `${r.label} ×${r.count}` : r.label)).join(' → ');
  }

  /**
   * Header badge for the last failure, or `null` when there is nothing to say.
   *
   * POISON and RELEASED are filtered out on purpose: the template already badges them from the
   * delivery counter, which is the durable source, whereas this one comes from a live event.
   */
  failureBadge(message: StreamMessage): { label: string; title: string } | null {
    const kind = message.failureKind;
    if (!kind || kind === 'POISON' || kind === 'RELEASED') return null;
    return FAILURE_LABELS[kind];
  }

  /** Stores the failure kind carried by a failure event, if the row is on screen. */
  private recordFailureKind(event: DLQEvent): void {
    if (!event.failureKind) return;
    const message = this.displayedMessages.find(m => m.id === event.messageId);
    if (message) {
      message.failureKind = event.failureKind;
      // A failed attempt is still an attempt: the row is behind us, so it dims like a successful one.
      message.handled = true;
      this.cdr.markForCheck();
    }
  }

  getFields(fields: Record<string, string>): {key: string; value: string}[] {
    // Prioritize paymentId and amount to appear first
    const priorityOrder = ['paymentId', 'amount'];
    // Every field is rendered, the sweep's own bookkeeping included: this viewer shows what the stream
    // holds. The header badge summarises it; it does not replace it. Cards are sized for the longest
    // entry instead (see the DLQ viewer's messageHeight on the page).
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

