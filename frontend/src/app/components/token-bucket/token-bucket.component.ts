import { Component, OnInit, OnDestroy, signal, inject, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { StreamRefreshService } from '../../services/stream-refresh.service';
import { MermaidDiagramComponent } from '../mermaid-diagram/mermaid-diagram.component';
import { DiagramDefinitionsService } from '../../services/diagram-definitions.service';

interface JobType {
  name: string;
  label: string;
  icon: string;
  maxConcurrency: number;
  defaultMax: number;
  running: number;
  jobCount: number;
  processingTime: string;
  color: string;
}

interface ChartData {
  payment: number;
  email: number;
  csv: number;
  payment_completed: number;
  email_completed: number;
  csv_completed: number;
}

/** `GET /config` and `GET /progress` both answer flat maps of counters keyed by job type. */
type CounterMap = Record<string, number>;

interface LogsResponse {
  submitted?: string[];
  completed?: string[];
}

interface SubmitResponse {
  submitted: number;
}

@Component({
  selector: 'app-token-bucket',
  standalone: true,
  imports: [FormsModule, MermaidDiagramComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './token-bucket.component.html',
  styleUrl: './token-bucket.component.scss'
})
export class TokenBucketComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private refreshService = inject(StreamRefreshService);
  diagrams = inject(DiagramDefinitionsService);
  private apiUrl = 'http://localhost:8080/api/token-bucket';
  private configPollInterval: ReturnType<typeof setInterval> | null = null;
  private progressPollInterval: ReturnType<typeof setInterval> | null = null;
  private logsPollInterval: ReturnType<typeof setInterval> | null = null;

  // Job types configuration (x10 jobs)
  jobTypes = signal<JobType[]>([
    { name: 'payment', label: 'Payment', icon: '💳', maxConcurrency: 3, defaultMax: 3, running: 0, jobCount: 150, processingTime: '4s', color: '#3b82f6' },
    { name: 'email', label: 'Email', icon: '📧', maxConcurrency: 2, defaultMax: 2, running: 0, jobCount: 100, processingTime: '4s', color: '#10b981' },
    { name: 'csv', label: 'CSV Export', icon: '📊', maxConcurrency: 1, defaultMax: 1, running: 0, jobCount: 50, processingTime: '10s', color: '#f59e0b' }
  ]);

  // State
  isSubmitting = signal(false);
  submitMessage = signal('');
  isSuccess = signal(true);

  // Chart data - history for bar chart animation
  chartData = signal<ChartData>({
    payment: 0, email: 0, csv: 0,
    payment_completed: 0, email_completed: 0, csv_completed: 0
  });

  // Logs
  submitLogs = signal<string[]>([]);
  completeLogs = signal<string[]>([]);

  ngOnInit(): void {
    this.clearAll();
    this.loadConfig();
    this.loadLogs();
    // Poll config every 500ms for live updates
    this.configPollInterval = setInterval(() => this.loadConfig(), 500);
    // Poll progress every 100ms for chart
    this.progressPollInterval = setInterval(() => this.loadProgress(), 100);
    // Poll logs every 300ms
    this.logsPollInterval = setInterval(() => this.loadLogs(), 300);
  }

  ngOnDestroy(): void {
    if (this.configPollInterval) clearInterval(this.configPollInterval);
    if (this.progressPollInterval) clearInterval(this.progressPollInterval);
    if (this.logsPollInterval) clearInterval(this.logsPollInterval);
  }

  loadConfig(): void {
    this.http.get<CounterMap>(`${this.apiUrl}/config`).subscribe({
      next: (config) => {
        const updated = this.jobTypes().map(jt => ({
          ...jt,
          maxConcurrency: config[`${jt.name}_max`] || jt.defaultMax,
          running: config[`${jt.name}_running`] || 0
        }));
        this.jobTypes.set(updated);
        this.cdr.markForCheck();
      }
    });
  }

  loadProgress(): void {
    this.http.get<CounterMap>(`${this.apiUrl}/progress`).subscribe({
      next: (data) => {
        this.chartData.set({
          payment: data['payment'] || 0,
          email: data['email'] || 0,
          csv: data['csv'] || 0,
          payment_completed: data['payment_completed'] || 0,
          email_completed: data['email_completed'] || 0,
          csv_completed: data['csv_completed'] || 0
        });
        this.cdr.markForCheck();
      }
    });
  }

  loadLogs(): void {
    this.http.get<LogsResponse>(`${this.apiUrl}/logs`).subscribe({
      next: (data) => {
        this.submitLogs.set(data.submitted || []);
        this.completeLogs.set(data.completed || []);
        this.cdr.markForCheck();
      }
    });
  }

  updateMaxConcurrency(jobType: JobType, value: number): void {
    this.http.put<void>(`${this.apiUrl}/config`, { type: jobType.name, maxConcurrency: value }).subscribe({
      next: () => {
        const updated = this.jobTypes().map(jt => 
          jt.name === jobType.name ? { ...jt, maxConcurrency: value } : jt
        );
        this.jobTypes.set(updated);
        this.cdr.markForCheck();
      }
    });
  }

  submitAllJobs(): void {
    this.isSubmitting.set(true);
    this.submitMessage.set('');
    this.cdr.markForCheck();

    let totalSubmitted = 0;
    const types = this.jobTypes();
    let completed = 0;

    types.forEach(jt => {
      this.http.post<SubmitResponse>(`${this.apiUrl}/submit`, { type: jt.name, count: jt.jobCount }).subscribe({
        next: (response) => {
          totalSubmitted += response.submitted;
          completed++;
          if (completed === types.length) {
            this.isSuccess.set(true);
            this.submitMessage.set(`✅ ${totalSubmitted} jobs submitted (${types.map(t => `${t.jobCount} ${t.label}`).join(', ')})`);
            this.isSubmitting.set(false);
            this.cdr.markForCheck();
          }
        },
        error: (err) => {
          completed++;
          if (completed === types.length) {
            this.isSuccess.set(false);
            this.submitMessage.set(`❌ Error: ${err.message}`);
            this.isSubmitting.set(false);
            this.cdr.markForCheck();
          }
        }
      });
    });
  }

  clearAll(): void {
    this.http.delete<void>(`${this.apiUrl}/clear`).subscribe({
      next: () => {
        this.refreshService.triggerRefresh();
        this.submitMessage.set('');
        this.loadConfig();
        this.cdr.markForCheck();
      }
    });
  }

  getTypeColor(type: string): string {
    const jt = this.jobTypes().find(j => j.name === type);
    return jt?.color || '#64748b';
  }

  getRunningCount(typeName: string): number {
    const data = this.chartData();
    return data[typeName as keyof ChartData] || 0;
  }

  getCompletedCount(typeName: string): number {
    const data = this.chartData();
    return data[`${typeName}_completed` as keyof ChartData] || 0;
  }

  getTotalCompleted(): number {
    const data = this.chartData();
    return data.payment_completed + data.email_completed + data.csv_completed;
  }

  getTotalJobs(): number {
    return this.jobTypes().reduce((sum, jt) => sum + jt.jobCount, 0);
  }
}

