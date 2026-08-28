import { Component, OnInit, ViewChild, signal, inject, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { StreamViewerComponent } from '../stream-viewer/stream-viewer.component';
import { StreamRefreshService } from '../../services/stream-refresh.service';
import { MermaidDiagramComponent } from '../mermaid-diagram/mermaid-diagram.component';
import { DiagramDefinitionsService } from '../../services/diagram-definitions.service';
import { keyColor } from '../../services/key-color';
import { PerKeyLanesComponent } from '../per-key-lanes/per-key-lanes.component';

interface Job {
  orderId: string;
  action: string;
  selected: boolean;
}

interface SubmitJobsResponse {
  jobsSubmitted: number;
}

@Component({
  selector: 'app-per-key-serialized',
  standalone: true,
  imports: [FormsModule, StreamViewerComponent, MermaidDiagramComponent, PerKeyLanesComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './per-key-serialized.component.html',
  styleUrl: './per-key-serialized.component.scss'
})
export class PerKeySerializedComponent implements OnInit {
  /** The time-slot grid, so `clearAll` can wipe it along with the streams. */
  @ViewChild(PerKeyLanesComponent) private lanes?: PerKeyLanesComponent;

  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private refreshService = inject(StreamRefreshService);
  diagrams = inject(DiagramDefinitionsService);
  private apiUrl = 'http://localhost:8080/api/per-key-serialized';

  // Predefined jobs
  /**
   * The batch the page submits: 24 jobs over **six** keys.
   *
   * Six is a ceiling, not a round number — `keyColor` distinguishes exactly these six and falls back
   * to slate for anything else, so a seventh key would put two indistinguishable grey blocks in the
   * time-slot grid and destroy the one thing the grid exists to show. Add depth (more actions on a
   * key), never a seventh key, unless the palette grows first.
   *
   * `#1001` carries seven actions on purpose: it is the chain a viewer follows to see serialization,
   * and a short chain finishes before the eye has settled.
   */
  jobs = signal<Job[]>([
    { orderId: '#1001', action: 'validateAddress', selected: true },
    { orderId: '#1001', action: 'checkFraud', selected: true },
    { orderId: '#1001', action: 'recalculateTotal', selected: true },
    { orderId: '#1001', action: 'reserveInventory', selected: true },
    { orderId: '#1001', action: 'processPayment', selected: true },
    { orderId: '#1001', action: 'scheduleDelivery', selected: true },
    { orderId: '#1001', action: 'sendConfirmationEmail', selected: true },
    { orderId: '#2002', action: 'recalculateTotal', selected: true },
    { orderId: '#2002', action: 'applyDiscount', selected: true },
    { orderId: '#2002', action: 'processPayment', selected: true },
    { orderId: '#2002', action: 'generateInvoice', selected: true },
    { orderId: '#3003', action: 'reserveInventory', selected: true },
    { orderId: '#3003', action: 'calculateShipping', selected: true },
    { orderId: '#3003', action: 'scheduleDelivery', selected: true },
    { orderId: '#3003', action: 'notifyWarehouse', selected: true },
    { orderId: '#4004', action: 'validateAddress', selected: true },
    { orderId: '#4004', action: 'calculateShipping', selected: true },
    { orderId: '#4004', action: 'updateLoyaltyPoints', selected: true },
    { orderId: '#5005', action: 'applyDiscount', selected: true },
    { orderId: '#5005', action: 'recalculateTotal', selected: true },
    { orderId: '#5005', action: 'generateInvoice', selected: true },
    { orderId: '#6006', action: 'generateInvoice', selected: true },
    { orderId: '#6006', action: 'sendConfirmationEmail', selected: true },
    { orderId: '#6006', action: 'archiveOrder', selected: true }
  ]);

  // State
  isSubmitting = signal(false);
  submitMessage = signal('');
  isSuccess = signal(true);

  ngOnInit(): void {
    // Clear streams at component init
    this.clearAll();
  }

  getSelectedJobs(): Job[] {
    return this.jobs().filter(j => j.selected);
  }

  submitJobs(): void {
    const selectedJobs = this.getSelectedJobs();
    if (selectedJobs.length === 0) {
      this.submitMessage.set('⚠️ No jobs selected');
      this.isSuccess.set(false);
      this.cdr.markForCheck();
      return;
    }

    this.isSubmitting.set(true);
    this.submitMessage.set('');
    this.cdr.markForCheck();

    const jobsToSend = selectedJobs.map(j => ({
      orderId: j.orderId,
      action: j.action
    }));

    this.http.post<SubmitJobsResponse>(`${this.apiUrl}/submit`, jobsToSend).subscribe({
      next: (response) => {
        this.isSuccess.set(true);
        this.submitMessage.set(`✅ ${response.jobsSubmitted} jobs submitted`);
        this.isSubmitting.set(false);
        this.cdr.markForCheck();
        setTimeout(() => { this.submitMessage.set(''); this.cdr.markForCheck(); }, 3000);
      },
      error: (err) => {
        this.isSuccess.set(false);
        this.submitMessage.set(`❌ Error: ${err.error?.error || err.message}`);
        this.isSubmitting.set(false);
        this.cdr.markForCheck();
      }
    });
  }

  clearAll(): void {
    this.http.delete<void>(`${this.apiUrl}/clear`).subscribe({
      next: () => {
        this.submitMessage.set('✅ All streams cleared');
        this.refreshService.triggerRefresh();
        // The viewers reload themselves from Redis on that refresh; the grid cannot — it is built
        // from live socket events and has no source to re-read. Without this it would keep showing
        // the old timeline over an empty keyspace.
        this.lanes?.reset();
        this.cdr.markForCheck();
        setTimeout(() => { this.submitMessage.set(''); this.cdr.markForCheck(); }, 2000);
      },
      error: (err) => {
        this.submitMessage.set(`❌ Error: ${err.message}`);
        this.cdr.markForCheck();
      }
    });
  }

  toggleJob(index: number): void {
    const currentJobs = this.jobs();
    currentJobs[index].selected = !currentJobs[index].selected;
    this.jobs.set([...currentJobs]);
    this.cdr.markForCheck();
  }

  getOrderColor(orderId: string): string {
    return keyColor(orderId);
  }
}

