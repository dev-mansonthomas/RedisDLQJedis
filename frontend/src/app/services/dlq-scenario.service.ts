import { Injectable, signal } from '@angular/core';

/**
 * Every action the DLQ page's button column can take.
 *
 * `ACK` / `NO_ACK` / `NACK_*` mirror the backend `ProcessOutcome` tokens; `GENERATE` and `CLEAR`
 * are page-level actions with no outcome semantics.
 */
export type DlqAction = 'GENERATE' | 'ACK' | 'NO_ACK' | 'NACK_FAIL' | 'NACK_FATAL' | 'NACK_SILENT' | 'CLEAR';

/** How far the operator has clicked through the currently displayed scenario. */
export interface ScenarioProgress {
  /** Scenario being narrated, or `null` before the first click and after a clear. */
  activeAction: DlqAction | null;
  /** Productions since the last clear — the "did you put messages in the stream" step. */
  generated: number;
  /** Clicks per outcome action since the active scenario started. */
  counts: Readonly<Record<string, number>>;
}

const EMPTY: ScenarioProgress = { activeAction: null, generated: 0, counts: {} };

/**
 * Tracks which DLQ scenario the operator is demonstrating, so the narration panel can state the
 * intent and the remaining steps.
 *
 * Sibling-to-sibling like {@link StreamRefreshService}, but a signal rather than a `Subject`: the
 * panel needs the *current* position in the scenario, which a fire-and-forget event stream cannot
 * answer for a component that mounted late.
 *
 * Every transition **replaces** the state object. An `OnPush` consumer reading a mutated-in-place
 * object never repaints — the regression this codebase has already paid for once.
 */
@Injectable({ providedIn: 'root' })
export class DlqScenarioService {
  private readonly state = signal<ScenarioProgress>(EMPTY);

  /** Current position in the narration. */
  readonly progress = this.state.asReadonly();

  /**
   * Folds a button click into the narration state.
   *
   * Switching outcome starts a new story, so the previous half-finished retry count is dropped
   * rather than carried over — otherwise the panel would claim progress the operator never made.
   */
  record(action: DlqAction): void {
    const current = this.state();

    if (action === 'CLEAR') {
      this.state.set(EMPTY);
      return;
    }

    if (action === 'GENERATE') {
      this.state.set({ activeAction: 'GENERATE', generated: current.generated + 1, counts: {} });
      return;
    }

    const repeat = current.activeAction === action ? (current.counts[action] ?? 0) : 0;
    this.state.set({
      activeAction: action,
      generated: current.generated,
      counts: { [action]: repeat + 1 }
    });
  }
}
