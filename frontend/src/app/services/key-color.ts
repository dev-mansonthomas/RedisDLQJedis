/**
 * Background colour for a business key.
 *
 * Shared rather than private to a component: the job list and the time-slot grid must tint the same
 * key identically, or reading one against the other is worse than having no colour at all.
 */
const KEY_COLORS: Record<string, string> = {
  '#1001': '#3b82f6',  // blue
  '#2002': '#10b981',  // green
  '#3003': '#f59e0b',  // orange
  '#4004': '#8b5cf6',  // purple
  '#5005': '#ec4899',  // pink
  '#6006': '#14b8a6'   // teal
};

/** Slate, for any key outside the demo palette. The cell keeps its text label. */
export const UNKNOWN_KEY_COLOR = '#64748b';

export function keyColor(key: string): string {
  return KEY_COLORS[key] ?? UNKNOWN_KEY_COLOR;
}
