import { Component, signal, inject, ChangeDetectionStrategy } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { API_BASE } from '../../api.config';

/**
 * Component for publishing messages to Redis Pub/Sub channels.
 * 
 * Provides a form to create and publish messages with custom fields.
 */
interface PublishResponse {
  subscriberCount: number;
}

@Component({
  selector: 'app-pubsub-producer',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="producer-container">
      <div class="producer-header">
        <h3 class="producer-title">📤 Producer</h3>
      </div>
    
      <div class="producer-content">
        <div class="form-group">
          <label for="channel">Channel</label>
          <input
            id="channel"
            type="text"
            [(ngModel)]="channel"
            placeholder="fire-and-forget"
            class="form-input">
        </div>
    
        <div class="form-group">
          <span class="group-label">Message Payload</span>
          <div class="payload-fields">
            @for (field of fields(); track field; let i = $index) {
              <div class="field-row">
                <input
                  type="text"
                  [(ngModel)]="field.key"
                  placeholder="Key"
                  class="form-input field-key">
                <input
                  type="text"
                  [(ngModel)]="field.value"
                  placeholder="Value"
                  class="form-input field-value">
                <button
                  (click)="removeField(i)"
                  class="btn-remove"
                  [disabled]="fields().length === 1">
                  ✕
                </button>
              </div>
            }
          </div>
          <button (click)="addField()" class="btn-add">+ Add Field</button>
        </div>
    
        <button
          (click)="publishMessage()"
          [disabled]="isPublishing()"
          class="btn-publish">
          {{ isPublishing() ? 'Publishing...' : '🚀 Publish Message' }}
        </button>
    
        @if (message()) {
          <div class="message" [class.success]="isSuccess()" [class.error]="!isSuccess()">
            {{ message() }}
          </div>
        }
      </div>
    </div>
    `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .producer-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      overflow: hidden;
    }

    .producer-header {
      padding: 16px;
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      color: white;
    }

    .producer-title {
      font-size: 16px;
      font-weight: 600;
      margin: 0;
    }

    .producer-content {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
    }

    .form-group {
      margin-bottom: 16px;
    }

    label, .group-label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      color: #475569;
      margin-bottom: 6px;
    }

    .form-input {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      font-size: 14px;
      transition: all 0.2s ease;
    }

    .form-input:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }

    .payload-fields {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 8px;
    }

    .field-row {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 8px;
      align-items: center;
    }

    .field-key, .field-value {
      width: 100%;
    }

    .btn-remove {
      padding: 8px 12px;
      background: #fee2e2;
      color: #dc2626;
      border: 1px solid #fca5a5;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      transition: all 0.2s ease;
    }

    .btn-remove:hover:not(:disabled) {
      background: #fca5a5;
      color: white;
    }

    .btn-remove:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-add {
      width: 100%;
      padding: 8px;
      background: #f1f5f9;
      color: #475569;
      border: 1px dashed #cbd5e1;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s ease;
    }

    .btn-add:hover {
      background: #e2e8f0;
      border-color: #94a3b8;
    }

    .btn-publish {
      width: 100%;
      padding: 12px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn-publish:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }

    .btn-publish:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .message {
      margin-top: 12px;
      padding: 12px;
      border-radius: 6px;
      font-size: 14px;
    }

    .message.success {
      background: #d1fae5;
      color: #065f46;
      border: 1px solid #6ee7b7;
    }

    .message.error {
      background: #fee2e2;
      color: #991b1b;
      border: 1px solid #fca5a5;
    }
  `]
})
export class PubsubProducerComponent {
  private http = inject(HttpClient);
  private apiUrl = `${API_BASE}/pubsub`;

  channel = 'fire-and-forget';
  fields = signal([
    { key: 'type', value: 'order' },
    { key: 'id', value: '12345' },
    { key: 'status', value: 'created' }
  ]);

  isPublishing = signal(false);
  message = signal('');
  isSuccess = signal(false);

  addField(): void {
    this.fields.update(fields => [...fields, { key: '', value: '' }]);
  }

  removeField(index: number): void {
    this.fields.update(fields => fields.filter((_, i) => i !== index));
  }

  publishMessage(): void {
    this.isPublishing.set(true);
    this.message.set('');

    // Build payload
    const payload: Record<string, string> = {};
    this.fields().forEach(field => {
      if (field.key && field.value) {
        payload[field.key] = field.value;
      }
    });

    // Publish
    this.http.post<PublishResponse>(`${this.apiUrl}/publish`, {
      channel: this.channel,
      payload: payload
    }).subscribe({
      next: (response) => {
        this.isSuccess.set(true);
        this.message.set(`✅ Published to ${response.subscriberCount} subscribers`);
        this.isPublishing.set(false);

        // Increment ID and randomize status for next message
        this.updateFieldsForNextMessage();

        setTimeout(() => this.message.set(''), 3000);
      },
      error: (error) => {
        this.isSuccess.set(false);
        this.message.set(`❌ Error: ${error.error?.error || error.message}`);
        this.isPublishing.set(false);
      }
    });
  }

  private updateFieldsForNextMessage(): void {
    const statuses = ['created', 'cancelled', 'updated'];

    this.fields.update(fields => {
      return fields.map(field => {
        // Increment ID field
        if (field.key === 'id') {
          const currentId = parseInt(field.value, 10);
          if (!isNaN(currentId)) {
            return { ...field, value: (currentId + 1).toString() };
          }
        }

        // Randomize status field
        if (field.key === 'status') {
          const randomStatus = statuses[Math.floor(Math.random() * statuses.length)];
          return { ...field, value: randomStatus };
        }

        return field;
      });
    });
  }
}

