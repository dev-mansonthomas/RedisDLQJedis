import { Component, OnInit, inject, ChangeDetectorRef, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { StreamViewerComponent } from '../stream-viewer/stream-viewer.component';
import { StreamRefreshService } from '../../services/stream-refresh.service';
import { RoutingRulesService, RoutingRule, RoutingMetadata } from '../../services/routing-rules.service';
import { MermaidDiagramComponent } from '../mermaid-diagram/mermaid-diagram.component';
import { DiagramDefinitionsService } from '../../services/diagram-definitions.service';

interface RoutedStream {
  streamName: string;
  messageId: string;
}

interface RoutingResult {
  success: boolean;
  eventId: string;
  routingKey: string;
  exchangeId: string;
  routedTo: RoutedStream[];
  rulesEvaluated?: number;
  rulesMatched?: number;
}

@Component({
  selector: 'app-topic-routing',
  standalone: true,
  imports: [CommonModule, FormsModule, StreamViewerComponent, MermaidDiagramComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="topic-routing-container">
      <div class="page-header">
        <h2>Topic Routing / Pattern Routing</h2>
        <p class="description">
          Messages are routed to different streams based on routing key patterns (like RabbitMQ topic exchange).
          Unlike simple pub/sub: messages are persisted and can go to multiple destinations.
        </p>
      </div>
    
      <!-- Controls Section -->
      <div class="controls-section">
        <div class="controls-row">
          <div class="routing-key-selector">
            <label for="tr-routing-key">Routing Key:</label>
            <select id="tr-routing-key" [(ngModel)]="selectedRoutingKey">
              @for (key of routingKeys; track key) {
                <option [value]="key">{{ key }}</option>
              }
            </select>
          </div>
    
          <button class="btn btn-route" (click)="routeMessage()">
            📤 Route Message
          </button>
    
          <button class="btn btn-clear" (click)="clearAllStreams()">
            🗑 Clear All
          </button>
    
          @if (messagesRouted > 0) {
            <div class="message-counter">
              Messages routed: <strong>{{ messagesRouted }}</strong>
            </div>
          }
        </div>
      </div>
    
      <!-- Stream Viewers -->
      <div class="streams-grid">
        <!-- Exchange Stream -->
        <div class="stream-section exchange-section">
          <h3>🔀 Exchange Stream (all messages)</h3>
          <app-stream-viewer
            [stream]="'events.topic.v1'"
            [pageSize]="10"
            [containerHeight]="200">
          </app-stream-viewer>
        </div>
    
        <!-- Target Streams - Order Routing Use Case -->
        <div class="stream-section">
          <h3>📦 Orders API v1 (*.v1)</h3>
          <app-stream-viewer
            [stream]="'events.order.v1'"
            [pageSize]="10"
            [containerHeight]="200">
          </app-stream-viewer>
        </div>
    
        <div class="stream-section">
          <h3>🚀 Orders API v2 (*.v2)</h3>
          <app-stream-viewer
            [stream]="'events.order.v2'"
            [pageSize]="10"
            [containerHeight]="200">
          </app-stream-viewer>
        </div>
    
        <div class="stream-section">
          <h3>⭐ VIP Notifications (*.vip.*)</h3>
          <app-stream-viewer
            [stream]="'events.notification.vip'"
            [pageSize]="10"
            [containerHeight]="200">
          </app-stream-viewer>
        </div>
    
        <div class="stream-section">
          <h3>🇪🇺 GDPR Notifications (*.eu.*)</h3>
          <app-stream-viewer
            [stream]="'events.notification.gdpr'"
            [pageSize]="10"
            [containerHeight]="200">
          </app-stream-viewer>
        </div>
    
        <div class="stream-section">
          <h3>📋 Cancelled Audit (order.cancelled.*)</h3>
          <app-stream-viewer
            [stream]="'events.audit.cancelled'"
            [pageSize]="10"
            [containerHeight]="200">
          </app-stream-viewer>
        </div>
      </div>
    
      <!-- Rules Management Section -->
      <div class="rules-section">
        <div class="rules-header">
          <h3>📋 Dynamic Routing Rules</h3>
          <div class="rules-actions">
            <button class="btn btn-add" (click)="showAddRuleDialog()" [disabled]="loadingRules">➕ Add Rule</button>
            <button class="btn btn-reset" (click)="resetToDefaults()" [disabled]="loadingRules">🔄 Reset</button>
          </div>
        </div>
    
        <!-- Error Message -->
        @if (rulesError) {
          <div class="error-message">
            <span>⚠️ {{ rulesError }}</span>
            <button class="retry-btn" (click)="retryLoadRules()">Retry</button>
          </div>
        }
    
        <!-- Loading State -->
        @if (loadingRules) {
          <div class="loading-rules">
            <span class="loading-spinner"></span>
            Loading routing rules...
          </div>
        }
    
        <!-- Metadata Panel -->
        @if (metadata && !loadingRules) {
          <div class="metadata-panel">
            <div class="metadata-item">
              <span class="meta-label">Max Rules:</span>
              <input type="number" [(ngModel)]="metadata.maxRules"
                (blur)="saveMetadata()" min="1" max="100" class="meta-input">
            </div>
            <div class="metadata-item">
              <span class="meta-label">Version:</span>
              <input type="text" [(ngModel)]="metadata.version"
                (blur)="saveMetadata()" class="meta-input">
            </div>
            <div class="metadata-item">
              <span class="meta-label">Rules:</span>
              <span class="meta-value">{{ rules.length }}</span>
            </div>
            <div class="metadata-item">
              <span class="meta-label">Updated:</span>
              <span class="meta-value">{{ metadata.updatedAt | date:'short' }}</span>
            </div>
          </div>
        }
    
        <!-- Rules Table -->
        @if (!loadingRules && rules.length > 0) {
          <div class="rules-table-container">
            <table class="rules-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Pattern (Lua)</th>
                  <th>Destination</th>
                  <th>Description</th>
                  <th>Priority</th>
                  <th>Enabled</th>
                  <th title="Stop evaluating other rules if this rule matches">Stop</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (rule of rules; track rule) {
                  <tr [class.disabled]="!rule.enabled" [class.stop-rule]="rule.stopOnMatch">
                    <td class="rule-id">{{ rule.id }}</td>
                    <td class="rule-pattern"><code>{{ rule.pattern }}</code></td>
                    <td class="rule-destination">{{ rule.destination }}</td>
                    <td class="rule-description">{{ rule.description }}</td>
                    <td class="rule-priority">{{ rule.priority }}</td>
                    <td class="rule-toggle">
                      <input type="checkbox" [(ngModel)]="rule.enabled"
                        (change)="toggleRuleEnabled(rule)">
                    </td>
                    <td class="rule-toggle">
                      <input type="checkbox" [(ngModel)]="rule.stopOnMatch"
                        (change)="saveRule(rule)" title="Stop evaluating rules after match">
                    </td>
                    <td class="rule-actions">
                      <button class="action-btn edit" (click)="editRule(rule)" title="Edit">✏️</button>
                      <button class="action-btn delete" (click)="deleteRule(rule)" title="Delete">🗑️</button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
    
        <!-- Empty State -->
        @if (!loadingRules && rules.length === 0 && !rulesError) {
          <div class="loading-rules">
            No routing rules configured. Click "Reset" to load default rules.
          </div>
        }
      </div>
    
      <!-- Rule Edit Modal -->
      @if (showRuleModal) {
        <div class="modal-overlay" (click)="onOverlayClick($event)" role="button" tabindex="0" aria-label="Close dialog" (keydown.escape)="closeRuleModal()" (keydown.enter)="closeRuleModal()" (keydown.space)="closeRuleModal()">
          <div class="modal-content">
            <div class="modal-header">
              <h3>{{ editingRule?.id ? 'Edit Rule' : 'Add Rule' }}</h3>
              <button class="close-btn" (click)="closeRuleModal()">✕</button>
            </div>
            @if (editingRule) {
              <div class="modal-body">
                <div class="form-group">
                  <label for="tr-rule-id">Rule ID *</label>
                  <input id="tr-rule-id" type="text" [(ngModel)]="editingRule.id"
                    [disabled]="isEditing" placeholder="e.g., 100">
                </div>
                <div class="form-group">
                  <label for="tr-rule-pattern">Lua Pattern *</label>
                  <input id="tr-rule-pattern" type="text" [(ngModel)]="editingRule.pattern"
                    placeholder="e.g., ^order%.">
                  <small>Lua patterns: ^ start, $ end, %. literal dot, %a letter, %d digit</small>
                </div>
                <div class="form-group">
                  <label for="tr-rule-destination">Destination Stream *</label>
                  <input id="tr-rule-destination" type="text" [(ngModel)]="editingRule.destination"
                    placeholder="e.g., events.order.v1">
                </div>
                <div class="form-group">
                  <label for="tr-rule-description">Description</label>
                  <input id="tr-rule-description" type="text" [(ngModel)]="editingRule.description"
                    placeholder="Describe this rule">
                </div>
                <div class="form-row">
                  <div class="form-group half">
                    <label for="tr-rule-priority">Priority</label>
                    <input id="tr-rule-priority" type="number" [(ngModel)]="editingRule.priority" min="1" max="999">
                    <small>Lower = higher priority</small>
                  </div>
                  <div class="form-group half">
                    <span class="group-label">Options</span>
                    <div class="checkbox-group">
                      <label><input type="checkbox" [(ngModel)]="editingRule.enabled"> Enabled</label>
                      <label><input type="checkbox" [(ngModel)]="editingRule.stopOnMatch"> Stop on Match</label>
                    </div>
                  </div>
                </div>
              </div>
            }
            <div class="modal-footer">
              <button class="btn btn-cancel" (click)="closeRuleModal()">Cancel</button>
              <button class="btn btn-save" (click)="saveEditingRule()">Save Rule</button>
            </div>
          </div>
        </div>
      }
    
      <!-- Architecture Diagram -->
      <app-mermaid-diagram
        title="View Architecture & Sequence Diagrams"
        [architectureDiagram]="diagrams.streamTopicRouting.architecture"
        [sequenceDiagram]="diagrams.streamTopicRouting.sequence">
      </app-mermaid-diagram>
    
      <!-- Info Box -->
      <div class="info-box">
        <div class="info-header">
          <span class="info-icon">ℹ️</span>
          <h3>Dynamic Topic Routing - Technical Details</h3>
        </div>
        <div class="info-content">
          <!-- Lua Function Details -->
          <div class="info-section">
            <h4>⚙️ Lua Function <code>route_message</code></h4>
            <ul>
              <li><strong>100% Generic</strong> - No business logic in Lua</li>
              <li><strong>Rules from Redis</strong> - Hash <code>routing:rules:&#123;exchange&#125;</code></li>
              <li><strong>Priority-based</strong> - Rules sorted by priority (lower = first)</li>
              <li><strong>Multi-destination</strong> - One message → N streams</li>
              <li><strong>Stop on Match</strong> - Like Gmail rules: stop processing if matched</li>
              <li><strong>Atomic</strong> - Single Redis transaction, no partial routing</li>
            </ul>
          </div>
    
          <!-- Stop on Match Explanation -->
          <div class="info-section">
            <h4>🛑 Stop on Match (like Gmail/Outlook rules)</h4>
            <p>When <code>stopOnMatch=true</code> on a rule:</p>
            <ul>
              <li>If the rule matches, <strong>no other rules are evaluated</strong></li>
              <li>Use with <strong>high priority</strong> (low number) for exclusive routing</li>
              <li>Example: Fraud events → Security team ONLY, nothing else</li>
              <li>Without this flag: message can match multiple rules (multi-destination)</li>
            </ul>
          </div>
    
          <!-- Advantages -->
          <div class="info-section">
            <h4>🚀 Advantages vs RabbitMQ/ActiveMQ</h4>
            <ul>
              <li><strong>Dynamic rules</strong> - Hot reload, no restart</li>
              <li><strong>Lua patterns</strong> - Regex-like (vs <code>*</code> and <code>#</code> only)</li>
              <li><strong>Stop on Match</strong> - Exclusive routing like email rules</li>
              <li><strong>Atomic routing</strong> - All-or-nothing in one transaction</li>
              <li><strong>Audit trail</strong> - Exchange stream = complete history</li>
              <li><strong>No message loss</strong> - Redis Streams persistence</li>
            </ul>
          </div>
    
          <!-- Lua Patterns -->
          <div class="info-section">
            <h4>🔧 Lua Pattern Syntax</h4>
            <ul>
              <li><code>^order%.</code> → starts with "order."</li>
              <li><code>%.critical$</code> → ends with ".critical"</li>
              <li><code>%.vip%.</code> → contains ".vip."</li>
              <li><code>^order%.%a+ed$</code> → order + past tense verb</li>
            </ul>
          </div>
    
          <!-- Pro Tip -->
          <div class="info-section tip-section">
            <h4>💡 Pro Tip: When NOT to use Lua Functions</h4>
            <p class="tip-text">
              <strong>Keep Lua functions generic!</strong> If you need business logic
              (validation, enrichment, external API calls), implement it in a
              <strong>microservice</strong> that consumes from the exchange stream,
              not in the Lua function. Lua should only handle routing mechanics.
            </p>
          </div>
        </div>
      </div>
    </div>
    `,
  styles: [`
    .topic-routing-container {
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

    .routing-key-selector {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .routing-key-selector label {
      color: #64748b;
      font-size: 14px;
    }

    .routing-key-selector select {
      padding: 10px 16px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      background: white;
      font-size: 14px;
      min-width: 200px;
    }

    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-route {
      background: #3b82f6;
      color: white;
    }

    .btn-route:hover {
      background: #2563eb;
    }

    .btn-clear {
      background: #6b7280;
      color: white;
    }

    .btn-clear:hover {
      background: #4b5563;
    }

    .message-counter {
      color: #64748b;
      font-size: 14px;
      padding: 8px 12px;
      background: #f1f5f9;
      border-radius: 6px;
    }

    /* Streams Grid */
    .streams-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }

    .stream-section {
      background: white;
      border-radius: 8px;
      padding: 16px;
      border: 1px solid #e2e8f0;
    }

    .stream-section.exchange-section {
      grid-column: 1 / -1;
      background: linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%);
    }

    .stream-section h3 {
      margin: 0 0 12px 0;
      font-size: 14px;
      color: #1e293b;
    }

    @media (max-width: 900px) {
      .streams-grid {
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
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
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

    .info-section code {
      background: #e2e8f0;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 12px;
      color: #0f172a;
    }

    .info-section.tip-section {
      grid-column: 1 / -1;
      background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
      border-color: #fbbf24;
    }

    .tip-text {
      margin: 0;
      font-size: 13px;
      color: #92400e;
      line-height: 1.7;
    }

    /* Loading indicator */
    .loading-rules {
      text-align: center;
      padding: 40px;
      color: #64748b;
    }

    .loading-spinner {
      display: inline-block;
      width: 24px;
      height: 24px;
      border: 3px solid #e2e8f0;
      border-top-color: #3b82f6;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-right: 8px;
      vertical-align: middle;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .error-message {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 8px;
      padding: 12px 16px;
      color: #dc2626;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .retry-btn {
      background: #dc2626;
      color: white;
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      margin-left: auto;
    }

    /* Rules Section */
    .rules-section {
      margin-top: 24px;
      background: white;
      border-radius: 12px;
      padding: 20px;
      border: 1px solid #e2e8f0;
    }

    .rules-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid #e2e8f0;
    }

    .rules-header h3 {
      margin: 0;
      font-size: 16px;
      color: #1e293b;
    }

    .rules-actions {
      display: flex;
      gap: 8px;
    }

    .btn-add {
      background: #10b981;
      color: white;
    }

    .btn-reset {
      background: #6366f1;
      color: white;
    }

    /* Metadata Panel */
    .metadata-panel {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      padding: 12px 16px;
      background: #f8fafc;
      border-radius: 8px;
      margin-bottom: 16px;
    }

    .metadata-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .meta-label {
      font-size: 12px;
      color: #64748b;
      font-weight: 500;
    }

    .meta-value {
      font-size: 13px;
      color: #1e293b;
      font-weight: 600;
    }

    .meta-input {
      width: 80px;
      padding: 4px 8px;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      font-size: 13px;
    }

    /* Rules Table */
    .rules-table-container {
      overflow-x: auto;
      max-height: 400px;
      overflow-y: auto;
    }

    .rules-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    .rules-table th {
      background: #f1f5f9;
      padding: 10px 12px;
      text-align: left;
      font-weight: 600;
      color: #475569;
      position: sticky;
      top: 0;
      border-bottom: 2px solid #e2e8f0;
    }

    .rules-table td {
      padding: 10px 12px;
      border-bottom: 1px solid #e2e8f0;
      vertical-align: middle;
    }

    .rules-table tr:hover {
      background: #f8fafc;
    }

    .rules-table tr.disabled {
      opacity: 0.5;
      background: #fef2f2;
    }

    .rules-table tr.stop-rule {
      background: linear-gradient(90deg, #fef3c7 0%, #fffbeb 100%);
      border-left: 3px solid #f59e0b;
    }

    .rules-table tr.stop-rule td:first-child::before {
      content: '⛔ ';
    }

    .rule-id {
      font-family: monospace;
      font-weight: 600;
      color: #6366f1;
    }

    .rule-pattern code {
      background: #dbeafe;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
      color: #1e40af;
    }

    .rule-destination {
      font-family: monospace;
      font-size: 12px;
      color: #059669;
    }

    .rule-description {
      color: #64748b;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .rule-priority {
      text-align: center;
      font-weight: 600;
    }

    .rule-toggle {
      text-align: center;
    }

    .rule-actions {
      display: flex;
      gap: 4px;
    }

    .action-btn {
      padding: 4px 8px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      background: transparent;
    }

    .action-btn:hover {
      background: #e2e8f0;
    }

    .action-btn.delete:hover {
      background: #fee2e2;
    }

    /* Modal */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .modal-content {
      background: white;
      border-radius: 12px;
      width: 500px;
      max-width: 90vw;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid #e2e8f0;
    }

    .modal-header h3 {
      margin: 0;
      font-size: 18px;
      color: #1e293b;
    }

    .close-btn {
      background: none;
      border: none;
      font-size: 20px;
      cursor: pointer;
      color: #64748b;
    }

    .modal-body {
      padding: 20px;
    }

    .form-group {
      margin-bottom: 16px;
    }

    .form-group label, .form-group .group-label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #374151;
      margin-bottom: 6px;
    }

    .form-group input[type="text"],
    .form-group input[type="number"] {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 14px;
      box-sizing: border-box;
    }

    .form-group small {
      display: block;
      margin-top: 4px;
      font-size: 11px;
      color: #6b7280;
    }

    .form-row {
      display: flex;
      gap: 16px;
    }

    .form-group.half {
      flex: 1;
    }

    .checkbox-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .checkbox-group label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: normal;
      cursor: pointer;
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      padding: 16px 20px;
      border-top: 1px solid #e2e8f0;
      background: #f9fafb;
    }

    .btn-cancel {
      background: #e5e7eb;
      color: #374151;
    }

    .btn-save {
      background: #3b82f6;
      color: white;
    }
  `]
})
export class TopicRoutingComponent implements OnInit {
  private http = inject(HttpClient);
  private refreshService = inject(StreamRefreshService);
  private rulesService = inject(RoutingRulesService);
  diagrams = inject(DiagramDefinitionsService);
  private apiUrl = 'http://localhost:8080/api/topic-routing';

  // Exchange stream name
  exchangeStream = 'events.topic.v1';

  // Routing keys - Order Routing use case
  // Pattern: order.<action>.<customer_type>.<region>.v<version>
  routingKeys: string[] = [
    // PLACED orders - demonstrate multi-destination routing
    'order.place.regular.us.v1',    // → v1 only
    'order.place.regular.eu.v1',    // → v1 + GDPR
    'order.place.regular.us.v2',    // → v2 only
    'order.place.regular.eu.v2',    // → v2 + GDPR
    'order.place.vip.us.v1',        // → v1 + VIP
    'order.place.vip.us.v2',        // → v2 + VIP
    'order.place.vip.eu.v1',        // → v1 + VIP + GDPR (max distribution!)
    'order.place.vip.eu.v2',        // → v2 + VIP + GDPR (max distribution!)
    // CANCELLED orders - demonstrate STOP ON MATCH
    'order.cancelled.regular.us.v1', // → Audit ONLY (STOP!)
    'order.cancelled.regular.eu.v1', // → Audit ONLY (STOP! no GDPR)
    'order.cancelled.vip.us.v1',     // → Audit ONLY (STOP! no VIP)
    'order.cancelled.vip.eu.v1'      // → Audit ONLY (STOP! no VIP, no GDPR)
  ];
  selectedRoutingKey = 'order.place.regular.us.v1';

  // State
  messagesRouted = 0;

  // Rules management
  rules: RoutingRule[] = [];
  metadata: RoutingMetadata | null = null;
  showRuleModal = false;
  editingRule: RoutingRule | null = null;
  isEditing = false;
  loadingRules = true;
  rulesError: string | null = null;

  private cdr = inject(ChangeDetectorRef);

  ngOnInit(): void {
    this.loadRules();
    this.loadMetadata();
  }

  // =========================================================================
  // Rules CRUD
  // =========================================================================

  loadRules(): void {
    this.loadingRules = true;
    this.rulesError = null;
    this.cdr.markForCheck();

    this.rulesService.getAllRules(this.exchangeStream).subscribe({
      next: (response) => {
        this.loadingRules = false;
        if (response.success) {
          this.rules = response.rules;
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.loadingRules = false;
        this.rulesError = 'Failed to load rules. Is the backend running on port 8080?';
        console.error('Failed to load rules:', err);
        this.cdr.markForCheck();
      }
    });
  }

  loadMetadata(): void {
    this.rulesService.getMetadata(this.exchangeStream).subscribe({
      next: (response) => {
        if (response.success) {
          this.metadata = response.metadata;
        }
      },
      error: (err) => console.error('Failed to load metadata:', err)
    });
  }

  retryLoadRules(): void {
    this.loadRules();
    this.loadMetadata();
  }

  showAddRuleDialog(): void {
    this.editingRule = this.rulesService.createEmptyRule();
    this.isEditing = false;
    this.showRuleModal = true;
  }

  editRule(rule: RoutingRule): void {
    this.editingRule = { ...rule };
    this.isEditing = true;
    this.showRuleModal = true;
  }

  /**
   * Closes only when the backdrop itself is clicked. Checking the target here is what lets the
   * inner card drop its `$event.stopPropagation()` click sink -- a handler that existed only to
   * cancel this one, and that no keyboard user could ever reach.
   */
  onOverlayClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.closeRuleModal();
    }
  }

  closeRuleModal(): void {
    this.showRuleModal = false;
    this.editingRule = null;
    this.isEditing = false;
  }

  saveEditingRule(): void {
    if (!this.editingRule) return;

    if (!this.editingRule.id || !this.editingRule.pattern || !this.editingRule.destination) {
      alert('Please fill in all required fields (ID, Pattern, Destination)');
      return;
    }

    this.rulesService.saveRule(this.exchangeStream, this.editingRule).subscribe({
      next: (response) => {
        if (response.success) {
          this.loadRules();
          this.loadMetadata();
          this.closeRuleModal();
        }
      },
      error: (err) => {
        console.error('Failed to save rule:', err);
        alert('Failed to save rule: ' + (err.error?.error || err.message));
      }
    });
  }

  saveRule(rule: RoutingRule): void {
    this.rulesService.saveRule(this.exchangeStream, rule).subscribe({
      next: () => this.loadMetadata(),
      error: (err) => console.error('Failed to save rule:', err)
    });
  }

  toggleRuleEnabled(rule: RoutingRule): void {
    this.saveRule(rule);
  }

  deleteRule(rule: RoutingRule): void {
    if (!confirm(`Delete rule "${rule.id}"?`)) return;

    this.rulesService.deleteRule(this.exchangeStream, rule.id).subscribe({
      next: (response) => {
        if (response.success) {
          this.loadRules();
          this.loadMetadata();
        }
      },
      error: (err) => console.error('Failed to delete rule:', err)
    });
  }

  saveMetadata(): void {
    if (!this.metadata) return;

    this.rulesService.saveMetadata(this.exchangeStream, this.metadata).subscribe({
      next: (response) => {
        if (response.success) {
          this.metadata = response.metadata;
        }
      },
      error: (err) => console.error('Failed to save metadata:', err)
    });
  }

  resetToDefaults(): void {
    if (!confirm('Reset all rules to defaults? This will delete all custom rules.')) return;

    this.rulesService.resetToDefaults(this.exchangeStream).subscribe({
      next: (response) => {
        if (response.success) {
          this.rules = response.rules;
          this.metadata = response.metadata;
        }
      },
      error: (err) => console.error('Failed to reset rules:', err)
    });
  }

  // =========================================================================
  // Message Routing
  // =========================================================================

  routeMessage(): void {
    this.http.post<RoutingResult>(`${this.apiUrl}/route`, null, {
      params: { routingKey: this.selectedRoutingKey }
    }).subscribe({
      next: (response) => {
        if (response.success) {
          this.messagesRouted++;
          this.cdr.markForCheck();
        }
      },
      error: (error) => {
        console.error('Failed to route message:', error);
      }
    });
  }

  clearAllStreams(): void {
    this.http.delete(`${this.apiUrl}/clear`).subscribe({
      next: () => {
        console.log('All topic routing streams cleared');
        this.messagesRouted = 0;
        this.cdr.markForCheck();

        setTimeout(() => {
          this.refreshService.triggerRefresh();
        }, 200);
      },
      error: (err) => console.error('Failed to clear streams:', err)
    });
  }
}
