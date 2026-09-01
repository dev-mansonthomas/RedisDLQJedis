import { Component, OnInit, OnDestroy, ChangeDetectorRef, inject, signal, ChangeDetectionStrategy } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { WebSocketService, DLQEvent } from '../../services/websocket.service';
import { MermaidDiagramComponent } from '../mermaid-diagram/mermaid-diagram.component';
import { DiagramDefinitionsService } from '../../services/diagram-definitions.service';
import { API_BASE } from '../../api.config';

interface RequestItem {
  itemId: string;
  description: string;
  quantity: number;
}

interface Request {
  orderId: string;
  items: RequestItem[];
  responseType: 'OK' | 'KO' | 'ERROR' | 'TIMEOUT';
}

interface Response {
  correlationId: string;
  orderId?: string;
  type: 'OK' | 'KO' | 'ERROR' | 'TIMEOUT' | null;
  items?: {itemId: string; quantity: number}[];
  outOfStockItems?: {itemId: string; quantityAsked: number; quantityAvailable: number}[];
  errorCorrelationId?: string;
  errorMessage?: string;
}

/** Shape of the `REQUEST_REPLY_RESPONSE:` payload carried by the WebSocket event. */
interface ResponsePayload {
  correlationId: string;
  responseType: 'OK' | 'KO' | 'ERROR' | 'TIMEOUT';
  orderId?: string;
  items?: Response['items'];
  outOfStockItems?: Response['outOfStockItems'];
  errorCorrelationId?: string;
  errorMessage?: string;
}

@Component({
  selector: 'app-request-reply',
  standalone: true,
  imports: [FormsModule, MermaidDiagramComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="container">
      <div class="page-header">
        <h1 class="page-title">Request/Reply Pattern</h1>
        <p class="page-description">Synchronous communication with timeout management using Redis Streams</p>
      </div>
    
      <div class="grid">
        <div class="card">
          <div class="card-header request-header">
            <h3 class="card-title">🚀 Send Request</h3>
          </div>
          <div class="card-content">
            <p class="stream-info">Stream: <code>order.holdInventory.v1</code></p>
    
            <div class="form-group">
              <label for="rr-order-id">Order ID</label>
              <input id="rr-order-id" type="text" [(ngModel)]="request.orderId" placeholder="ORD-12345" />
            </div>
    
            <div class="form-group">
              <label for="rr-response-type">Response Type</label>
              <select id="rr-response-type" [(ngModel)]="request.responseType" class="form-select">
                <option value="OK">✅ OK - Success response</option>
                <option value="KO">❌ KO - Out of stock</option>
                <option value="ERROR">⚠️ ERROR - Processing error (no ACK, goes to DLQ)</option>
                <option value="TIMEOUT">⏱️ TIMEOUT - No response (simulates timeout)</option>
              </select>
            </div>
    
            <div class="form-group">
              <span class="group-label">Items</span>
              <table>
                <thead>
                  <tr>
                    <th>Item ID</th>
                    <th>Description</th>
                    <th>Quantity</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  @for (item of request.items; track item; let i = $index) {
                    <tr>
                      <td><input type="text" [(ngModel)]="item.itemId" placeholder="ITEM-001" /></td>
                      <td><input type="text" [(ngModel)]="item.description" placeholder="Widget A" /></td>
                      <td><input type="number" [(ngModel)]="item.quantity" placeholder="10" min="1" /></td>
                      <td><button (click)="removeItem(i)" class="btn-remove">✕</button></td>
                    </tr>
                  }
                </tbody>
              </table>
              <button (click)="addItem()" class="btn-add">+ Add Item</button>
            </div>
    
            <button (click)="sendRequest()" [disabled]="isSending || !request.orderId || request.items.length === 0" class="btn-send">
              <span class="btn-icon">🚀</span>
              {{ isSending ? 'Sending...' : 'Send Request' }}
            </button>
    
            @if (response.correlationId) {
              <div class="correlation-id">
                <strong>Correlation ID:</strong> <code>{{ response.correlationId }}</code>
              </div>
            }
          </div>
        </div>
    
        <div class="card">
          <div class="card-header response-header">
            <div class="header-left">
              <h3 class="card-title">📨 Response</h3>
              <span class="connection-status" [class.connected]="isConnected()" [class.disconnected]="!isConnected()">
                <span class="status-dot"></span>
                {{ isConnected() ? 'WS Connected' : 'WS Disconnected' }}
              </span>
            </div>
          </div>
          <div class="card-content">
            <p class="stream-info">Stream: <code>order.holdInventory.response.v1</code></p>
    
            @if (!response.type && response.correlationId) {
              <div class="no-response">
                Waiting for response... Time elapsed: {{ elapsedSeconds }} sec
              </div>
            }
            @if (!response.type && !response.correlationId) {
              <div class="no-response">
                Waiting for request...
              </div>
            }
    
            @if (response.type === 'OK') {
              <div class="response response-ok">
                <div class="response-header"><span class="badge badge-ok">✓ OK</span> Inventory Hold</div>
                <p><strong>Order ID:</strong> {{ response.orderId }}</p>
                <p><strong>Correlation ID:</strong> <code>{{ response.correlationId }}</code></p>
                <table>
                  <thead><tr><th>Item ID</th><th>Quantity</th></tr></thead>
                  <tbody>
                    @for (item of response.items; track item) {
                      <tr>
                        <td>{{ item.itemId }}</td>
                        <td>{{ item.quantity }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
    
            @if (response.type === 'KO') {
              <div class="response response-ko">
                <div class="response-header"><span class="badge badge-ko">✗ KO</span> Out of Stock</div>
                <p><strong>Order ID:</strong> {{ response.orderId }}</p>
                <p><strong>Correlation ID:</strong> <code>{{ response.correlationId }}</code></p>
                <table>
                  <thead><tr><th>Item ID</th><th>Asked</th><th>Available</th></tr></thead>
                  <tbody>
                    @for (item of response.outOfStockItems; track item) {
                      <tr>
                        <td>{{ item.itemId }}</td>
                        <td>{{ item.quantityAsked }}</td>
                        <td>{{ item.quantityAvailable }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
    
            @if (response.type === 'ERROR') {
              <div class="response response-error">
                <div class="response-header"><span class="badge badge-error">⚠ ERROR</span> Service Error</div>
                <p><strong>Order ID:</strong> {{ response.orderId }}</p>
                <p><strong>Correlation ID:</strong> <code>{{ response.correlationId }}</code></p>
                <p><strong>Error ID:</strong> <code>{{ response.errorCorrelationId }}</code></p>
                <p class="error-message">{{ response.errorMessage }}</p>
              </div>
            }
    
            @if (response.type === 'TIMEOUT') {
              <div class="response response-timeout">
                <div class="response-header"><span class="badge badge-timeout">⏱ TIMEOUT</span> Request Timeout</div>
                <p><strong>Order ID:</strong> {{ response.orderId }}</p>
                <p><strong>Correlation ID:</strong> <code>{{ response.correlationId }}</code></p>
                <p class="timeout-message">The request timed out after 10 seconds.</p>
              </div>
            }
    
            @if (response.type) {
              <button (click)="clearResponse()" class="btn-secondary">Clear</button>
            }
          </div>
        </div>
      </div>
    
      <!-- Architecture Diagram -->
      <app-mermaid-diagram
        title="View Architecture & Sequence Diagrams"
        [architectureDiagram]="diagrams.requestReply.architecture"
        [sequenceDiagram]="diagrams.requestReply.sequence">
      </app-mermaid-diagram>
    
      <div class="info-box">
        <div class="info-header">
          <span class="info-icon">ℹ️</span>
          <h3>How Request/Reply Works</h3>
        </div>
        <div class="info-content">
          <div class="info-section">
            <h4>📤 Request Flow</h4>
            <ol>
              <li><strong>Client sends request</strong> to <code>order.holdInventory.v1</code> stream with a unique <code>correlationId</code></li>
              <li><strong>Timeout mechanism</strong>: Two Redis keys are created:
              <ul>
                <li><code>timeout_key</code>: Expires after 10 seconds (triggers Redis keyspace notification)</li>
                <li><code>shadow_key</code>: Contains metadata (businessId, streamResponseName) for timeout handling</li>
              </ul>
            </li>
            <li><strong>Worker processes request</strong> from the request stream using consumer group</li>
            <li><strong>Worker sends response</strong> to <code>order.holdInventory.response.v1</code> stream with the same <code>correlationId</code></li>
          </ol>
        </div>
        <div class="info-section">
          <h4>📥 Response Flow</h4>
          <ol>
            <li><strong>Response listener</strong> reads from response stream using <code>read_claim_or_dlq</code> Lua function</li>
            <li><strong>Matches correlationId</strong> to deliver response to the correct client</li>
            <li><strong>Timer stops</strong> when response is received</li>
            <li><strong>Failed responses</strong> (ERROR type, no ACK) go to DLQ after 2 delivery attempts</li>
          </ol>
        </div>
        <div class="info-section">
          <h4>⏱️ Timeout Handling</h4>
          <ol>
            <li><strong>Redis keyspace notification</strong>: When <code>timeout_key</code> expires, Redis publishes an event to <code>__keyevent@0__:expired</code></li>
            <li><strong>KeyspaceNotificationListener</strong> receives the expiration event via <code>psubscribe</code></li>
            <li><strong>Reads shadow_key</strong> to get metadata (businessId, streamResponseName)</li>
            <li><strong>Sends TIMEOUT response</strong> using Lua <code>response</code> function to the response stream</li>
            <li><strong>Cleans up shadow_key</strong> and broadcasts via WebSocket</li>
          </ol>
        </div>
        <div class="info-section">
          <h4>🎯 Response Types</h4>
          <ul>
            <li><strong>✅ OK</strong>: Success response with inventory hold confirmation (ACK ✅)</li>
            <li><strong>❌ KO</strong>: Business rejection (out of stock) (ACK ✅)</li>
            <li><strong>⚠️ ERROR</strong>: Processing error, no ACK ❌ → goes to DLQ after 2 attempts</li>
            <li><strong>⏱️ TIMEOUT</strong>: Worker doesn't respond, no ACK ❌ → timeout after 10 seconds</li>
          </ul>
        </div>
        <div class="info-section">
          <h4>🔧 Technical Details</h4>
          <ul>
            <li><strong>Lua Functions</strong>: <code>request</code> (send request + timeout keys), <code>response</code> (send response + cleanup timeout keys), <code>read_claim_or_dlq</code> (read/claim/DLQ)</li>
            <li><strong>Consumer Groups</strong>: <code>request-group</code> (workers), <code>response-group</code> (response listener)</li>
            <li><strong>DLQ Stream</strong>: <code>order.holdInventory.response.v1:dlq</code> for failed responses</li>
            <li><strong>Max Delivery Count</strong>: 2 attempts before moving to DLQ</li>
            <li><strong>Min Idle Time</strong>: 5 seconds before claiming pending messages</li>
            <li><strong>WebSocket</strong>: Real-time response delivery to Angular UI</li>
          </ul>
        </div>
        <div class="info-section">
          <h4>📈 Horizontal Scalability</h4>
          <ul>
            <li><strong>Multiple Workers</strong>: Deploy multiple worker instances (pods, containers) to process requests in parallel</li>
            <li><strong>Redis Consumer Groups</strong>: Automatically distribute messages across workers - each request is processed by exactly ONE worker</li>
            <li><strong>Load Balancing</strong>: Redis handles load balancing natively - no external load balancer needed</li>
            <li><strong>Unique Consumer Names</strong>: Each worker instance must have a unique consumer name (e.g., <code>worker-1</code>, <code>worker-2</code>, <code>worker-3</code>)</li>
            <li><strong>Correlation ID</strong>: Ensures responses are routed correctly regardless of which worker processed the request</li>
            <li><strong>Fault Tolerance</strong>: If a worker crashes, pending messages are automatically claimed by other workers after <code>minIdleTime</code></li>
            <li><strong>No Single Point of Failure</strong>: Add/remove workers dynamically without downtime</li>
          </ul>
        </div>
        <div class="info-section">
          <h4>📋 Service Contract Versioning</h4>
          <ul>
            <li><strong>Version in Stream Names</strong>: <code>order.holdInventory.<strong>v1</strong></code> and <code>order.holdInventory.response.<strong>v1</strong></code></li>
            <li><strong>Contract Stability</strong>: The <code>v1</code> suffix defines a stable interface contract (request/response schema)</li>
            <li><strong>Breaking Changes</strong>: If the worker needs to change its contract (new fields, different structure), deploy a new version:
            <ul>
              <li>New streams: <code>order.holdInventory.v2</code> and <code>order.holdInventory.response.v2</code></li>
              <li>New worker microservice listens to <code>v2</code> streams</li>
              <li>Old <code>v1</code> workers continue serving existing clients</li>
            </ul>
          </li>
          <li><strong>Parallel Versions</strong>: Run <code>v1</code> and <code>v2</code> workers simultaneously during migration period</li>
          <li><strong>Client Migration</strong>: Clients can migrate from <code>v1</code> to <code>v2</code> at their own pace</li>
          <li><strong>Backward Compatibility</strong>: No forced upgrades - each version is independent</li>
          <li><strong>Deprecation Strategy</strong>: Retire <code>v1</code> streams only when all clients have migrated to <code>v2</code></li>
        </ul>
      </div>
    </div>
    </div>
    </div>
    `,
  styles: [`.container{max-width:1400px;margin:0 auto;padding:20px}.page-header{margin-bottom:24px}.page-title{font-size:32px;font-weight:700;color:#1e293b;margin:0 0 8px 0}.page-description{color:#64748b;margin:0}.info-box{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;margin-top:24px;box-shadow:0 1px 3px rgba(0,0,0,.05)}.info-header{display:flex;align-items:center;gap:12px;margin-bottom:20px;padding-bottom:16px;border-bottom:2px solid #e2e8f0}.info-icon{font-size:24px}.info-header h3{margin:0;font-size:20px;font-weight:600;color:#1e293b}.info-content{display:grid;grid-template-columns:1fr 1fr;gap:24px}.info-section{background:#f8fafc;padding:16px;border-radius:6px;border-left:4px solid #667eea}.info-section h4{margin:0 0 12px 0;font-size:16px;font-weight:600;color:#334155}.info-section ol,.info-section ul{margin:0;padding-left:20px;color:#475569;font-size:14px;line-height:1.6}.info-section li{margin-bottom:8px}.info-section code{background:#e0e7ff;color:#4338ca;padding:2px 6px;border-radius:4px;font-size:13px;font-family:monospace}.info-section strong{color:#1e293b}.info-section ul ul{margin-top:4px;font-size:13px}@media (max-width:1024px){.info-content{grid-template-columns:1fr}}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:24px}.card{display:flex;flex-direction:column;height:100%;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden}.card-header{padding:16px;color:#fff}.request-header{background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%)}.response-header{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)}.header-left{display:flex;flex-direction:column;gap:6px}.card-title{font-size:16px;font-weight:600;margin:0}.connection-status{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:500;padding:3px 8px;border-radius:10px;background:rgba(255,255,255,.15);width:fit-content}.connection-status.connected{background:rgba(34,197,94,.2)}.connection-status.disconnected{background:rgba(239,68,68,.2)}.status-dot{width:6px;height:6px;border-radius:50%;background:#fff}.connection-status.connected .status-dot{background:#22c55e;animation:pulse 2s ease-in-out infinite}.connection-status.disconnected .status-dot{background:#ef4444}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}.card-content{flex:1;padding:16px;overflow-y:auto}.stream-info{font-size:14px;color:#64748b;margin-bottom:16px}.stream-info code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:13px}.form-group{margin-bottom:16px}.form-group label,.form-group .group-label{display:block;font-weight:600;margin-bottom:8px;color:#334155;font-size:14px}input[type=text],input[type=number],.form-select{width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px;transition:all .2s ease}input[type=text]:focus,input[type=number]:focus,.form-select:focus{outline:0;border-color:#667eea;box-shadow:0 0 0 3px rgba(102,126,234,.1)}.form-select{background:#fff;cursor:pointer}table{width:100%;border-collapse:collapse;margin-bottom:12px}table thead{background:#f8fafc}table th{padding:10px;text-align:left;font-size:13px;font-weight:600;color:#475569;border-bottom:2px solid #e2e8f0}table td{padding:8px}table td input{margin:0}.btn-remove{padding:6px 10px;background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;transition:all .2s ease}.btn-remove:hover:not(:disabled){background:#fecaca;transform:scale(1.1)}.btn-remove:disabled{opacity:.5;cursor:not-allowed}.btn-add{background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:8px 12px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;transition:all .2s ease}.btn-add:hover{background:#e2e8f0;border-color:#94a3b8}.btn-send{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;border:none;padding:14px 28px;border-radius:8px;cursor:pointer;font-size:15px;font-weight:600;width:100%;transition:all .3s ease;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 2px 8px rgba(102,126,234,.3)}.btn-send:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 6px 20px rgba(102,126,234,.5)}.btn-send:active:not(:disabled){transform:translateY(0);box-shadow:0 2px 8px rgba(102,126,234,.3)}.btn-send:disabled{opacity:.6;cursor:not-allowed;transform:none;box-shadow:none}.btn-icon{font-size:18px;display:inline-block;transition:transform .3s ease}.btn-send:hover:not(:disabled) .btn-icon{transform:translateX(3px)}.btn-secondary{background:#64748b;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:14px;margin-top:16px;width:100%;transition:all .2s ease}.btn-secondary:hover{background:#475569}.correlation-id{margin-top:16px;padding:12px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;font-size:13px}.correlation-id code{background:#e0f2fe;padding:2px 6px;border-radius:4px;font-family:monospace}.no-response{display:flex;align-items:center;justify-content:center;padding:40px 20px;color:#94a3b8;font-size:14px;font-style:italic}.response{padding:16px;border-radius:8px;margin-bottom:16px;animation:fadeIn .3s ease-in}@keyframes fadeIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}.response-ok{background:#f0fdf4;border:1px solid #bbf7d0}.response-ko{background:#fef2f2;border:1px solid #fecaca}.response-error{background:#fef2f2;border:1px solid #fecaca}.response-timeout{background:#fefce8;border:1px solid #fde047}.response-header{font-size:16px;font-weight:600;margin-bottom:12px}.response p{margin:8px 0;font-size:14px;color:#334155}.response strong{color:#1e293b}.response code{background:rgba(0,0,0,.05);padding:2px 6px;border-radius:4px;font-family:monospace;font-size:12px}.badge{display:inline-block;padding:4px 8px;border-radius:4px;font-size:12px;font-weight:600;margin-right:8px}.badge-ok{background:#22c55e;color:#fff}.badge-ko{background:#ef4444;color:#fff}.badge-error{background:#f97316;color:#fff}.badge-timeout{background:#eab308;color:#fff}.error-message,.timeout-message{color:#64748b;font-style:italic;margin-top:8px}@media (max-width:768px){.grid{grid-template-columns:1fr}table{font-size:12px}table th,table td{padding:6px}}`]
})
export class RequestReplyComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private wsService = inject(WebSocketService);
  private cdr = inject(ChangeDetectorRef);
  diagrams = inject(DiagramDefinitionsService);
  private wsSubscription?: Subscription;

  isSending = false;
  isConnected = signal(false);

  request: Request = {
    orderId: 'ORD-9393',
    items: [
      { itemId: 'ITEM-001', description: 'Widget A', quantity: 10 },
      { itemId: 'ITEM-002', description: 'Widget B', quantity: 5 }
    ],
    responseType: 'OK'
  };

  response: Response = {
    correlationId: '',
    type: null
  };

  // Timer for tracking request duration
  elapsedSeconds = 0;
  private timerInterval?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    // Connect to WebSocket for real-time response delivery
    this.wsService.connect();

    // Monitor WebSocket connection status
    this.isConnected.set(this.wsService.isConnected());

    // Subscribe to connection status changes
    this.wsService.getConnectionStatus().subscribe((connected: boolean) => {
      console.log('RequestReply: WebSocket connection status changed:', connected);
      this.isConnected.set(connected);
      this.cdr.markForCheck();
    });

    this.wsSubscription = this.wsService.getEvents().subscribe((event: DLQEvent) => {
      console.log('RequestReply: Received WebSocket event:', event);

      // Update connection status
      this.isConnected.set(true);

      if (event.details && event.details.startsWith('REQUEST_REPLY_RESPONSE:')) {
        try {
          const jsonStr = event.details.substring('REQUEST_REPLY_RESPONSE:'.length);
          const responseData = JSON.parse(jsonStr);
          this.handleResponse(responseData);
        } catch (e) {
          console.error('Error parsing Request/Reply response:', e);
        }
      }
    });
  }

  ngOnDestroy(): void {
    this.wsSubscription?.unsubscribe();
    this.stopTimer();
  }

  private startTimer(): void {
    this.elapsedSeconds = 0;
    this.stopTimer(); // Clear any existing timer
    this.timerInterval = setInterval(() => {
      this.elapsedSeconds++;
      this.cdr.markForCheck();
    }, 1000);
  }

  private stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = undefined;
    }
  }

  addItem(): void {
    this.request.items.push({ itemId: '', description: '', quantity: 1 });
  }

  removeItem(index: number): void {
    this.request.items.splice(index, 1);
  }

  sendRequest(): void {
    this.isSending = true;
    this.response = { correlationId: '', type: null };
    this.startTimer(); // Start the timer

    const payload = {
      orderId: this.request.orderId,
      items: this.request.items,
      responseType: this.request.responseType
    };

    this.http.post<{success: boolean; correlationId: string}>(`${API_BASE}/request-reply/send`, payload)
      .subscribe({
        next: (result) => {
          console.log('Request sent, correlation ID:', result.correlationId);
          this.response.correlationId = result.correlationId;
          this.isSending = false;
          this.cdr.markForCheck();
        },
        error: (error) => {
          console.error('Error sending request:', error);
          this.isSending = false;
          this.stopTimer(); // Stop timer on error
          alert('Error sending request: ' + error.message);
        }
      });
  }

  clearResponse(): void {
    this.response = { correlationId: '', type: null };
    this.cdr.markForCheck();
  }

  private handleResponse(responseData: ResponsePayload): void {
    console.log('Handling response:', responseData);

    if (responseData.correlationId !== this.response.correlationId) {
      console.log('Ignoring response for different correlation ID');
      return;
    }

    // Stop the timer when response is received
    this.stopTimer();

    this.response.type = responseData.responseType;
    this.response.orderId = responseData.orderId;

    switch (responseData.responseType) {
      case 'OK':
        this.response.items = responseData.items;
        break;
      case 'KO':
        this.response.outOfStockItems = responseData.outOfStockItems;
        break;
      case 'ERROR':
        this.response.errorCorrelationId = responseData.errorCorrelationId;
        this.response.errorMessage = responseData.errorMessage;
        break;
      case 'TIMEOUT':
        break;
    }

    this.cdr.markForCheck();
  }
}
