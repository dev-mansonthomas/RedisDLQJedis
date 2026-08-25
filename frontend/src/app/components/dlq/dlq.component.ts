import { Component, inject, ChangeDetectionStrategy } from '@angular/core';

import { StreamViewerComponent } from '../stream-viewer/stream-viewer.component';
import { DlqConfigComponent } from '../dlq-config/dlq-config.component';
import { DlqActionsComponent } from '../dlq-actions/dlq-actions.component';
import { DlqNarrationComponent } from '../dlq-narration/dlq-narration.component';
import { MermaidDiagramComponent } from '../mermaid-diagram/mermaid-diagram.component';
import { DiagramDefinitionsService } from '../../services/diagram-definitions.service';

@Component({
  selector: 'app-dlq',
  standalone: true,
  imports: [StreamViewerComponent, DlqConfigComponent, DlqActionsComponent, DlqNarrationComponent, MermaidDiagramComponent],
  template: `
    <div class="dlq-container">
      <div class="page-header">
        <h1 class="page-title">Dead Letter Queue (DLQ)</h1>
        <p class="page-description">
          Demonstrate Redis DLQ messaging patterns with real-time monitoring and testing capabilities.
        </p>
      </div>

      <div class="content-layout">
        <!-- Configuration Section -->
        <div class="config-section">
          <app-dlq-config></app-dlq-config>
        </div>

        <!-- Streams Section -->
        <!-- pageSize 20, not 10: the window shows the NEWEST entries while the consumer group hands
             out the OLDEST first, so once the stream exceeds the window the next message to be
             processed is off-screen and a click looks like a no-op. Generate produces six, so 20
             covers three clicks. There is no pagination to fall back on (there never was).
             Column height 861, measured rather than estimated: 6 cells at a 127px pitch (125 + 2px
             gap), less the trailing gap, plus 16px of container padding = 776px of content, plus 85px
             of viewer header/footer. One click on Generate leaves all six messages on screen. -->
        <div class="streams-section">
          <div class="stream-column">
            <app-stream-viewer
              stream="test-stream"
              group="test-group"
              consumer="consumer-1"
              [pageSize]="20"
              [showNextIndicator]="true"
              [containerHeight]="861">
            </app-stream-viewer>
          </div>

          <div class="actions-column">
            <app-dlq-actions></app-dlq-actions>
          </div>

          <div class="stream-column">
            <!-- Taller cards than the source column: a swept entry carries the original payload PLUS
                 the sweep's reason / originalId / failedVia, and every row is meant to be readable. -->
            <app-stream-viewer
              stream="test-stream:dlq"
              group="dlq-group"
              consumer="dlq-consumer"
              [pageSize]="20"
              [messageHeight]="205"
              [containerHeight]="861">
            </app-stream-viewer>
          </div>
        </div>

        <!-- Narration: what the button just clicked demonstrates, and what is left to do.
             Full width rather than inside the actions column, which is too narrow for a step list. -->
        <app-dlq-narration></app-dlq-narration>

        <!-- Architecture Diagram -->
        <app-mermaid-diagram
          title="View Architecture & Sequence Diagrams"
          [architectureDiagram]="diagrams.dlq.architecture"
          [sequenceDiagram]="diagrams.dlq.sequence">
        </app-mermaid-diagram>

        <!-- DLQ Pattern Explanation -->
        <div class="explanation-section">
          <h3 class="explanation-title">🔄 DLQ Pattern Logic</h3>

          <!-- XADD Command Example -->
          <div class="xadd-example">
            <div class="xadd-line">
              <span class="xadd-command">XADD</span>
              <span class="xadd-stream">test-stream</span>
              <span class="xadd-id">*</span>
              <span class="xadd-field">type</span> <span class="xadd-value">order.created</span>
              <span class="xadd-field">order_id</span> <span class="xadd-value">12345</span>
              <span class="xadd-field">amount</span> <span class="xadd-value">99.99</span>
            </div>
          </div>

          <div class="pseudocode">
            <div class="code-block">
              <div class="code-line"><span class="keyword">function</span> <span class="function"> getNextMessages</span>()  <span class="comment">// Java</span>:</div>
              <div class="code-line indent1">messages = <span class="function">read_claim_or_dlq</span>()  <span class="comment">// Lua script</span></div>
              <div class="code-line indent1"><span class="keyword">return</span> messages</div>
              <div class="code-line"></div>
              <div class="code-line"><span class="comment">// Lua: read_claim_or_dlq()</span></div>
              <div class="code-line indent1"><span class="comment">// 1. XPENDING → find idle messages</span></div>
              <div class="code-line indent1"><span class="comment">// 2. If deliveries >= max:</span></div>
              <div class="code-line indent2"><span class="comment">// XCLAIM + XADD(dlq) + XACK</span></div>
              <div class="code-line indent1"><span class="comment">// 3. XREADGROUP CLAIM → get pending + new</span></div>
            </div>
            <div class="code-block">
              <div class="code-line"><span class="keyword">function</span> <span class="success"> processSuccess</span>()  <span class="comment">// Java</span>:</div>
              <div class="code-line indent1">msg = <span class="function">getNextMessages</span>()</div>
              <div class="code-line indent1"><span class="comment">// 💼 Process business logic</span></div>
              <div class="code-line indent1"><span class="function">XACK</span>(msg)  <span class="comment">// ✅ Remove from PENDING</span></div>
            </div>
            <div class="code-block">
              <div class="code-line"><span class="keyword">function</span> <span class="error"> processFail</span>()  <span class="comment">// Java</span>:</div>
              <div class="code-line indent1">msg = <span class="function">getNextMessages</span>()</div>
              <div class="code-line indent1"><span class="comment">// ❌ No ACK → stays in PENDING (owned)</span></div>
              <div class="code-line indent1"><span class="comment">// → retried only after minIdleMs</span></div>
              <div class="code-line indent1"><span class="comment">// → redelivered until deliveries == maxDeliveries</span></div>
              <div class="code-line indent1"><span class="comment">// → NEXT poll sweeps it to DLQ + removes it from UI</span></div>
            </div>
            <div class="code-block">
              <div class="code-line"><span class="keyword">function</span> <span class="error"> processExplicitFail</span>()  <span class="comment">// Redis 8.8+</span>:</div>
              <div class="code-line indent1">msg = <span class="function">getNextMessages</span>()</div>
              <div class="code-line indent1"><span class="function">XNACK</span>(msg, FAIL | FATAL | SILENT)</div>
              <div class="code-line indent1"><span class="comment">// released NOW — no minIdle wait</span></div>
              <div class="code-line indent1"><span class="comment">// FAIL: budget kept · FATAL: → DLQ next poll</span></div>
              <div class="code-line indent1"><span class="comment">// SILENT: budget refunded (deliveries = 0)</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .dlq-container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px;
    }

    .page-header {
      margin-bottom: 24px;
    }

    .page-title {
      font-size: 28px;
      font-weight: 700;
      color: #1e293b;
      margin: 0 0 8px 0;
    }

    .page-description {
      font-size: 16px;
      color: #64748b;
      margin: 0;
      line-height: 1.6;
    }

    .content-layout {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .config-section {
      width: 100%;
    }

    .streams-section {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: 16px;
      min-height: 500px;
    }

    .stream-column {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .actions-column {
      display: flex;
      flex-direction: column;
      width: 200px;
      min-height: 0;
    }

    .explanation-section {
      margin-top: 24px;
      padding: 20px;
      background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
    }

    .explanation-title {
      font-size: 18px;
      font-weight: 600;
      color: #1e293b;
      margin: 0 0 16px 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .xadd-example {
      margin-bottom: 16px;
      padding: 12px 16px;
      background: #1e293b;
      border-radius: 6px;
      border: 1px solid #334155;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }

    .xadd-line {
      font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
      font-size: 14px;
      line-height: 1.8;
      color: #e2e8f0;
    }

    .xadd-command {
      color: #f59e0b;
      font-weight: 700;
      margin-right: 8px;
    }

    .xadd-stream {
      color: #10b981;
      font-weight: 600;
      margin-right: 8px;
    }

    .xadd-id {
      color: #8b5cf6;
      font-weight: 600;
      margin-right: 8px;
    }

    .xadd-field {
      color: #3b82f6;
      font-weight: 600;
      margin-right: 4px;
    }

    .xadd-value {
      color: #ec4899;
      font-weight: 500;
      margin-right: 8px;
    }

    .pseudocode {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
      font-size: 13px;
      line-height: 1.6;
    }

    .code-block {
      background: #ffffff;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid #e2e8f0;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    }

    .code-line {
      margin: 2px 0;
      white-space: nowrap;
    }

    .indent1 { padding-left: 20px; }
    .indent2 { padding-left: 40px; }

    .keyword {
      color: #7c3aed;
      font-weight: 600;
    }

    .function {
      color: #0891b2;
      font-weight: 500;
    }

    .comment {
      color: #64748b;
      font-style: italic;
    }

    .success {
      color: #16a34a;
      font-weight: 600;
    }

    .error {
      color: #dc2626;
      font-weight: 600;
    }

    @media (max-width: 1024px) {
      .streams-section {
        grid-template-columns: 1fr;
      }

      .actions-column {
        width: 100%;
      }

      .pseudocode {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 768px) {
      .dlq-container {
        padding: 12px;
      }

      .page-title {
        font-size: 24px;
      }

      .bottom-section {
        grid-template-columns: 1fr;
      }
    }
  `]
})
export class DlqComponent {
  diagrams = inject(DiagramDefinitionsService);
}