import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';

import { DlqAction, DlqScenarioService } from '../../services/dlq-scenario.service';

/** One step of a scenario, satisfied once its action has been clicked `target` times. */
interface StepDef {
  /** Button that satisfies this step; `null` for a terminal instruction that only the operator can judge. */
  action: DlqAction | null;
  label: string;
  /** Cumulative clicks of `action` needed. `'budget'` = maxDeliveries, `'budget+1'` = the sweeping click. */
  target: number | 'budget' | 'budget+1';
}

interface ScenarioDef {
  title: string;
  /** What we want a customer to take away. */
  intent: string;
  /** The command-level truth behind it, so the claim is checkable. */
  redisTruth: string;
  steps: StepDef[];
  /** What the screen should show once the scenario is complete. */
  outcome: string;
}

interface NarratedStep {
  label: string;
  status: 'done' | 'current' | 'pending';
  /** `"1 of 2"` for repeated steps, empty for single-click ones. */
  progress: string;
}

/**
 * Per-outcome narration for the DLQ page.
 *
 * Every step count is derived from the live `maxDeliveries`, and every claim below was measured
 * against the running stack rather than reasoned about — including the counter-intuitive one: the
 * click that routes a message to the DLQ answers `success: false` and paints a red banner.
 */
const SCENARIOS: Record<Exclude<DlqAction, 'CLEAR'>, ScenarioDef> = {
  GENERATE: {
    title: 'Messages in the stream',
    intent: 'Six random order events are appended to the stream. Nothing is consumed yet — a stream '
      + 'is a log waiting to be read, not a queue that drains itself.',
    redisTruth: 'XADD test-stream * type … — the entries exist independently of any consumer, and the '
      + "consumer group's pending list is still empty.",
    steps: [
      { action: 'GENERATE', label: 'Generate messages — XADD six order events', target: 1 },
      { action: null, label: 'Pick an outcome below: what should happen when a consumer processes one?', target: 1 }
    ],
    outcome: 'Left panel: the entries appear, none dimmed. Right panel: the DLQ is empty.'
  },

  ACK: {
    title: 'Happy path — acknowledged work leaves the pending list',
    intent: 'Show that a consumer which finishes its work clears the message from the pending list, '
      + 'and that the entry itself is not destroyed.',
    redisTruth: 'XACK drops the message from the group PEL. There is no XDEL anywhere in this demo: a '
      + 'stream is append-only, so the row stays — dimmed, with an "acked" badge.',
    steps: [
      { action: 'GENERATE', label: 'Generate messages first — there must be something to process', target: 1 },
      { action: 'ACK', label: 'Process & Success — the consumer XACKs the message', target: 1 }
    ],
    outcome: 'The row is dimmed and badged "acked", and the total message count is unchanged — proof '
      + 'that acknowledging is not deleting. The DLQ stays empty.'
  },

  NO_ACK: {
    title: 'Consumer crash — no message is lost',
    intent: 'Show that a consumer dying mid-work loses nothing: the message stays owned in the pending '
      + 'list and is redelivered later — and that after a bounded number of attempts it is parked in '
      + 'the DLQ instead of being retried forever.',
    redisTruth: 'No XACK is sent, so the entry stays in the PEL, still owned by the dead consumer. It '
      + 'becomes reclaimable only once it has been idle for minIdle ms. When the delivery counter '
      + 'reaches maxDeliveries, the next poll claims it, XADDs it to the DLQ and XACKs the original.',
    steps: [
      { action: 'GENERATE', label: 'Generate messages', target: 1 },
      { action: 'NO_ACK', label: 'Process & Fail (timeout) — each click burns one delivery attempt', target: 'budget' },
      {
        action: 'NO_ACK',
        target: 'budget+1',
        label: 'Click it once more to trigger the sweep. Expect "No messages available to process" in '
          + 'red — that banner IS the sweep: the poll found the message over budget, moved it to the '
          + 'DLQ, and so had nothing left to hand you.'
      }
    ],
    outcome: 'Left panel: the message is gone from the pending set. Right panel: it is now in the DLQ, '
      + 'payload intact, ready for inspection or replay.'
  },

  NACK_FAIL: {
    title: 'Explicit failure — hand the message back now, not in minIdle ms',
    intent: 'Show what Redis 8.8 adds: a consumer that knows it failed can return the message '
      + 'immediately, instead of playing dead and making everyone wait out the idle timeout.',
    redisTruth: 'XNACK … FAIL leaves the entry in the PEL but unowned (consumer empty, idle -1), so it '
      + 'is re-claimable at once and bypasses minIdle. The delivery counter is kept, so the retry '
      + 'budget is consumed exactly as a crash would consume it.',
    steps: [
      { action: 'GENERATE', label: 'Generate messages', target: 1 },
      { action: 'NACK_FAIL', label: 'Process & Explicit Fail — released instantly, budget still charged', target: 'budget' },
      {
        action: 'NACK_FAIL',
        target: 'budget+1',
        label: 'Click it once more: the next poll sweeps the over-budget message to the DLQ, and '
          + 'reports "No messages available to process".'
      }
    ],
    outcome: 'Same destination as the crash scenario, reached without any idle wait — that latency '
      + 'difference is the entire point of the explicit NACK.'
  },

  NACK_FATAL: {
    title: 'Poison message — stop retrying something that can never work',
    intent: 'Show that an unprocessable message (bad schema, unknown type) does not have to burn the '
      + 'whole retry budget before being parked.',
    redisTruth: 'XNACK … FATAL forces the delivery counter to Long.MAX_VALUE, so the next poll sweeps '
      + 'the entry to the DLQ whatever maxDeliveries says. The UI spots the poison by threshold, never '
      + 'by equality — Long.MAX_VALUE loses precision once it crosses JSON into JavaScript.',
    steps: [
      { action: 'GENERATE', label: 'Generate messages', target: 1 },
      { action: 'NACK_FATAL', label: 'Process & Poison — one call retires the message', target: 1 },
      {
        action: 'NACK_FATAL',
        target: 2,
        label: 'Click it once more: the sweep happens on the next poll, and reports "No messages '
          + 'available to process".'
      }
    ],
    outcome: 'The message is in the DLQ after a single failure instead of maxDeliveries of them — '
      + 'retries spent only where a retry could actually help.'
  },

  NACK_SILENT: {
    title: 'Graceful release — give the message back without penalty',
    intent: 'Show the clean-shutdown case: a consumer stopping on purpose must return its in-flight '
      + 'message without charging it a failed attempt it never deserved.',
    redisTruth: 'XNACK … SILENT refunds its OWN delivery and leaves the entry unowned. With nothing '
      + 'charged before it, the counter lands back on 0. It does not wipe charges already on the clock: '
      + 'measured, a Fail followed by a Release leaves the counter at 1 — so mixing the two can still '
      + 'reach the DLQ.',
    steps: [
      { action: 'GENERATE', label: 'Generate messages', target: 1 },
      { action: 'NACK_SILENT', label: 'Process & Release (silent) — this delivery is refunded', target: 1 },
      {
        action: 'NACK_SILENT',
        target: 3,
        label: 'Click it twice more. Nothing accumulates while releasing is the only thing you do, so a '
          + 'pure release loop never reaches the DLQ — that is the graceful-shutdown guarantee.'
      }
    ],
    outcome: 'The message is still pending and still intact after every release, and the DLQ is empty. '
      + 'Try a Fail first, then a Release, to see the difference: that earlier attempt stays charged.'
  }
};

const FALLBACK_MAX_DELIVERIES = 2;

@Component({
  selector: 'app-dlq-narration',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (narration(); as n) {
      <section class="narration" aria-live="polite">
        <header class="narration-header">
          <span class="badge">What this demonstrates</span>
          <h3 class="narration-title">{{ n.title }}</h3>
        </header>

        <div class="narration-body">
          <div class="col intent-col">
            <p class="intent">{{ n.intent }}</p>
            <p class="redis-truth"><span class="truth-label">In Redis terms</span>{{ n.redisTruth }}</p>
          </div>

          <div class="col steps-col">
            <span class="group-label">Steps to complete the scenario</span>
            <ol class="steps">
              @for (step of n.steps; track $index) {
                <li class="step" [class.done]="step.status === 'done'" [class.current]="step.status === 'current'">
                  <span class="marker">{{ step.status === 'done' ? '✓' : $index + 1 }}</span>
                  <span class="step-label">{{ step.label }}</span>
                  @if (step.progress) {
                    <span class="step-progress">{{ step.progress }}</span>
                  }
                </li>
              }
            </ol>
          </div>
        </div>

        <p class="outcome" [class.reached]="n.complete">
          <span class="outcome-label">{{ n.complete ? 'You should now see' : 'You will see' }}</span>{{ n.outcome }}
        </p>
      </section>
    }
    `,
  styles: [`
    .narration {
      background: white;
      border: 1px solid #e2e8f0;
      border-left: 4px solid #3b82f6;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      overflow: hidden;
    }

    .narration-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid #e2e8f0;
      background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
    }

    .badge {
      flex: none;
      padding: 3px 8px;
      border-radius: 4px;
      background: #dbeafe;
      color: #1d4ed8;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .narration-title {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
      color: #1e293b;
    }

    .narration-body {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 20px;
      padding: 16px;
    }

    .col { min-width: 0; }

    .intent {
      margin: 0 0 12px;
      font-size: 14px;
      line-height: 1.55;
      color: #1e293b;
    }

    .redis-truth {
      margin: 0;
      padding: 10px 12px;
      border-radius: 6px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      font-size: 13px;
      line-height: 1.5;
      color: #475569;
    }

    .truth-label, .outcome-label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #64748b;
      margin-bottom: 4px;
    }

    .group-label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #64748b;
      margin-bottom: 8px;
    }

    .steps {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .step {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr) auto;
      align-items: start;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid transparent;
      font-size: 13px;
      line-height: 1.45;
      color: #64748b;
    }

    .step .marker {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #e2e8f0;
      color: #64748b;
      font-size: 11px;
      font-weight: 700;
    }

    .step.done {
      color: #475569;
    }

    .step.done .marker {
      background: #d1fae5;
      color: #047857;
    }

    .step.current {
      background: #eff6ff;
      border-color: #bfdbfe;
      color: #1e293b;
      font-weight: 500;
    }

    .step.current .marker {
      background: #3b82f6;
      color: white;
    }

    .step-progress {
      flex: none;
      padding: 1px 7px;
      border-radius: 10px;
      background: #f1f5f9;
      color: #475569;
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }

    .step.current .step-progress {
      background: #3b82f6;
      color: white;
    }

    .outcome {
      margin: 0;
      padding: 12px 16px;
      border-top: 1px solid #e2e8f0;
      background: #f8fafc;
      font-size: 13px;
      line-height: 1.5;
      color: #475569;
    }

    .outcome.reached {
      background: #f0fdf4;
      border-top-color: #bbf7d0;
      color: #166534;
    }

    @media (max-width: 1100px) {
      .narration-body { grid-template-columns: minmax(0, 1fr); }
    }
  `]
})
export class DlqNarrationComponent {
  private readonly http = inject(HttpClient);
  private readonly scenarios = inject(DlqScenarioService);
  private readonly apiUrl = 'http://localhost:8080/api/dlq';

  /**
   * Retry budget read from the backend, so the step counts match the value the config panel actually
   * saved instead of duplicating its default.
   */
  private readonly maxDeliveries = signal(FALLBACK_MAX_DELIVERIES);

  readonly narration = computed(() => {
    const progress = this.scenarios.progress();
    if (!progress.activeAction || progress.activeAction === 'CLEAR') return null;

    const def = SCENARIOS[progress.activeAction];
    const budget = this.maxDeliveries();

    let firstUnsatisfied = -1;
    const resolved = def.steps.map((step, index) => {
      const target = step.target === 'budget' ? budget
        : step.target === 'budget+1' ? budget + 1
        : step.target;
      const clicks = step.action === null ? 0
        : step.action === 'GENERATE' ? progress.generated
        : progress.counts[step.action] ?? 0;
      const satisfied = step.action !== null && clicks >= target;
      if (!satisfied && firstUnsatisfied === -1) firstUnsatisfied = index;
      return { label: step.label, satisfied, clicks: Math.min(clicks, target), target };
    });

    const steps: NarratedStep[] = resolved.map((step, index) => ({
      label: step.label,
      status: step.satisfied ? 'done' : index === firstUnsatisfied ? 'current' : 'pending',
      progress: step.target > 1 ? `${step.clicks} of ${step.target}` : ''
    }));

    return { ...def, steps, complete: firstUnsatisfied === -1 };
  });

  constructor() {
    this.http.get<{ maxDeliveries: number }>(`${this.apiUrl}/config?streamName=test-stream`)
      .subscribe({
        next: config => this.maxDeliveries.set(config.maxDeliveries ?? FALLBACK_MAX_DELIVERIES),
        // A demo page must still narrate correctly when the backend is down; the default matches
        // DLQParameters.maxDeliveries.
        error: () => this.maxDeliveries.set(FALLBACK_MAX_DELIVERIES)
      });
  }
}
