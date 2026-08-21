import { Component, OnInit, inject, ChangeDetectionStrategy } from '@angular/core';

import { PubsubProducerComponent } from '../pubsub-producer/pubsub-producer.component';
import { PubsubSubscriberComponent } from '../pubsub-subscriber/pubsub-subscriber.component';
import { WebSocketService } from '../../services/websocket.service';
import { MermaidDiagramComponent } from '../mermaid-diagram/mermaid-diagram.component';
import { DiagramDefinitionsService } from '../../services/diagram-definitions.service';

/**
 * Main component for the Pub/Sub messaging pattern demonstration.
 * 
 * Layout:
 * - Column 1: Producer (publish messages)
 * - Column 2: Redis icon (visual separator)
 * - Column 3: Two subscribers (receive messages)
 */
@Component({
  selector: 'app-pubsub',
  standalone: true,
  imports: [PubsubProducerComponent, PubsubSubscriberComponent, MermaidDiagramComponent],
  template: `
    <div class="pubsub-container">
      <div class="page-header">
        <h1 class="page-title">Publish/Subscribe (Pub/Sub)</h1>
        <p class="page-description">
          Demonstrate Redis Pub/Sub pattern with fire-and-forget messaging and real-time broadcasting to multiple subscribers.
        </p>
      </div>

      <div class="content-layout">
        <!-- Column 1: Producer -->
        <div class="producer-column">
          <app-pubsub-producer></app-pubsub-producer>
        </div>

        <!-- Column 2: Redis Icon -->
        <div class="icon-column">
          <div class="icon-container">
            <img src="assets/img/icon-streams-64-duotone.png" alt="Redis" class="redis-icon">
            <div class="icon-label">Redis Pub/Sub</div>
            <div class="icon-description">Fire & Forget</div>
          </div>
        </div>

        <!-- Column 3: Subscribers -->
        <div class="subscribers-column">
          <app-pubsub-subscriber
            title="Subscriber 1"
            channel="fire-and-forget">
          </app-pubsub-subscriber>

          <app-pubsub-subscriber
            title="Subscriber 2"
            channel="fire-and-forget">
          </app-pubsub-subscriber>
        </div>
      </div>

      <!-- Architecture Diagram -->
      <app-mermaid-diagram
        title="View Architecture & Sequence Diagrams"
        [architectureDiagram]="diagrams.pubsub.architecture"
        [sequenceDiagram]="diagrams.pubsub.sequence">
      </app-mermaid-diagram>

      <!-- Pattern Explanation -->
      <div class="explanation-section">
        <h3 class="explanation-title">🔥 Pub/Sub Pattern (Fire & Forget)</h3>
        <div class="explanation-content">
          <div class="explanation-block">
            <div class="block-title">📤 Publisher</div>
            <div class="block-code">
              <div class="code-line"><span class="function">PUBLISH</span>(channel, message)</div>
              <div class="code-line comment">// Fire & forget - no delivery guarantee</div>
            </div>
          </div>

          <div class="explanation-block">
            <div class="block-title">🔄 Redis Pub/Sub</div>
            <div class="block-code">
              <div class="code-line">✅ Ephemeral (no persistence)</div>
              <div class="code-line">✅ Instant broadcast to all subscribers</div>
              <div class="code-line">❌ No delivery guarantee</div>
              <div class="code-line">❌ Lost if no subscribers listening</div>
            </div>
          </div>

          <div class="explanation-block">
            <div class="block-title">📥 Subscribers</div>
            <div class="block-code">
              <div class="code-line"><span class="function">SUBSCRIBE</span>(channel)</div>
              <div class="code-line comment">// All subscribers receive same message</div>
              <div class="code-line comment">// Real-time, simultaneous delivery</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .pubsub-container {
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
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: 24px;
      min-height: 600px;
      margin-bottom: 24px;
    }

    .producer-column {
      display: flex;
      flex-direction: column;
    }

    .icon-column {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 16px;
    }

    .icon-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }

    .redis-icon {
      width: 64px;
      height: 64px;
      opacity: 0.8;
    }

    .icon-label {
      font-size: 14px;
      font-weight: 600;
      color: #475569;
      text-align: center;
    }

    .icon-description {
      font-size: 12px;
      color: #94a3b8;
      text-align: center;
    }

    .subscribers-column {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .explanation-section {
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
    }

    .explanation-content {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
    }

    .explanation-block {
      background: white;
      padding: 16px;
      border-radius: 6px;
      border: 1px solid #e2e8f0;
    }

    .block-title {
      font-size: 14px;
      font-weight: 600;
      color: #475569;
      margin-bottom: 12px;
    }

    .block-code {
      font-family: 'Monaco', 'Menlo', monospace;
      font-size: 13px;
      line-height: 1.6;
    }

    .code-line {
      margin: 4px 0;
    }

    .function {
      color: #0891b2;
      font-weight: 600;
    }

    .comment {
      color: #64748b;
      font-style: italic;
    }

    @media (max-width: 1024px) {
      .content-layout {
        grid-template-columns: 1fr;
      }

      .icon-column {
        display: none;
      }

      .explanation-content {
        grid-template-columns: 1fr;
      }
    }
  `]
})
export class PubsubComponent implements OnInit {
  private wsService = inject(WebSocketService);
  diagrams = inject(DiagramDefinitionsService);

  ngOnInit(): void {
    // Connect to WebSocket for real-time message delivery
    this.wsService.connect();
  }
}

