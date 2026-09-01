import { Component, OnInit, signal, inject, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { StreamViewerComponent } from '../stream-viewer/stream-viewer.component';
import { StreamRefreshService } from '../../services/stream-refresh.service';
import { MermaidDiagramComponent } from '../mermaid-diagram/mermaid-diagram.component';
import { DiagramDefinitionsService } from '../../services/diagram-definitions.service';
import { API_BASE } from '../../api.config';

interface RoutingRule {
  condition: string;
  target: string;
}

interface RulesResponse {
  success: boolean;
  rules: Record<string, RoutingRule>;
}

interface SubmitPaymentResponse {
  paymentId: string;
  willRouteTo: string;
}

@Component({
  selector: 'app-content-based-routing',
  standalone: true,
  imports: [FormsModule, StreamViewerComponent, MermaidDiagramComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './content-based-routing.component.html',
  styleUrl: './content-based-routing.component.scss'
})
export class ContentBasedRoutingComponent implements OnInit {
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private refreshService = inject(StreamRefreshService);
  diagrams = inject(DiagramDefinitionsService);
  private apiUrl = `${API_BASE}/content-routing`;

  // Form fields
  paymentId = signal('');
  amount = signal(50);
  country = signal('US');
  method = signal('card');

  // State
  isSubmitting = signal(false);
  submitMessage = signal('');
  isSuccess = signal(false);

  // Stream names
  incomingStream = 'payments.incoming.v1';
  highRiskStream = 'payments.highRisk.v1';
  standardStream = 'payments.standard.v1';
  manualReviewStream = 'payments.manualReview.v1';
  dlqStream = 'payments.incoming.v1:dlq';

  // Routing rules
  routingRules = signal<Record<string, RoutingRule>>({});

  // Preset amounts for quick selection (matching new thresholds)
  presetAmounts = [
    { label: 'Standard ($50)', value: 50, color: '#10b981' },      // < 100 → standard
    { label: 'High Risk ($500)', value: 500, color: '#f59e0b' },   // 100-10000 → highRisk
    { label: 'Manual ($150000)', value: 150000, color: '#ef4444' }, // >= 10000 → manualReview
    { label: 'Error (-$15)', value: -15, color: '#6b7280' }         // < 0 → DLQ
  ];

  countries = ['US', 'EU', 'UK', 'CA', 'AU', 'JP'];
  methods = ['card', 'bank_transfer', 'crypto', 'paypal'];

  ngOnInit(): void {
    this.generatePaymentId();
    this.loadRoutingRules();
  }

  /** Generate a random PaymentId in format PAY-XXXXXXXX */
  generatePaymentId(): void {
    const randomPart = Array.from({ length: 8 }, () =>
      '0123456789ABCDEF'.charAt(Math.floor(Math.random() * 16))
    ).join('');
    this.paymentId.set(`PAY-${randomPart}`);
  }

  loadRoutingRules(): void {
    this.http.get<RulesResponse>(`${this.apiUrl}/rules`).subscribe({
      next: (res) => {
        if (res.success) {
          this.routingRules.set(res.rules);
          this.cdr.markForCheck();
        }
      },
      error: (err) => console.error('Failed to load routing rules:', err)
    });
  }

  setPresetAmount(value: number): void {
    this.amount.set(value);
  }

  // Routing logic matching backend (100 = highRisk threshold, 10000 = manualReview threshold)
  getTargetStream(): string {
    const amt = this.amount();
    if (amt < 0) return this.dlqStream;
    if (amt >= 10000) return this.manualReviewStream;
    if (amt >= 100) return this.highRiskStream;
    return this.standardStream;
  }

  getTargetColor(): string {
    const target = this.getTargetStream();
    if (target === this.dlqStream) return '#6b7280';
    if (target === this.manualReviewStream) return '#ef4444';
    if (target === this.highRiskStream) return '#f59e0b';
    return '#10b981';
  }

  submitPayment(): void {
    this.isSubmitting.set(true);
    this.submitMessage.set('');

    // Use current paymentId for the request
    const currentPaymentId = this.paymentId();

    this.http.post<SubmitPaymentResponse>(`${this.apiUrl}/submit`, {
      paymentId: currentPaymentId,
      amount: this.amount(),
      country: this.country(),
      method: this.method()
    }).subscribe({
      next: (res) => {
        this.isSuccess.set(true);
        this.submitMessage.set(`✅ Payment ${res.paymentId} submitted → ${res.willRouteTo}`);
        this.isSubmitting.set(false);
        // Generate new paymentId for next submission
        this.generatePaymentId();
        this.cdr.markForCheck();
        setTimeout(() => { this.submitMessage.set(''); this.cdr.markForCheck(); }, 4000);
      },
      error: (err) => {
        this.isSuccess.set(false);
        this.submitMessage.set(`❌ Error: ${err.error?.error || err.message}`);
        this.isSubmitting.set(false);
        this.cdr.markForCheck();
      }
    });
  }

  clearStreams(): void {
    this.http.delete<void>(`${this.apiUrl}/clear`).subscribe({
      next: () => {
        this.submitMessage.set('✅ All streams cleared');
        this.refreshService.triggerRefresh();
        this.cdr.markForCheck();
        setTimeout(() => { this.submitMessage.set(''); this.cdr.markForCheck(); }, 2000);
      },
      error: (err) => { this.submitMessage.set(`❌ Error: ${err.message}`); this.cdr.markForCheck(); }
    });
  }

  clearAll(): void {
    this.clearStreams();
  }
}

