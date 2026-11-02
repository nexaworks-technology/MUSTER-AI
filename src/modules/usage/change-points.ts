/**
 * Usage change points for the timeline: a week whose average daily active users differs from
 * the previous four weeks' average by at least 30%. Only the first week of a run in the same
 * direction is reported, so a long decline is one event, not ten. Pure and deterministic.
 */
export interface WeekValue {
  weekStart: Date;
  avgActive: number;
}

export interface ChangePoint {
  weekStart: Date;
  direction: "up" | "down";
  pct: number;
  value: number;
  baseline: number;
}

export const CHANGE_THRESHOLD = 0.3;
const MIN_BASELINE = 3;

export function usageChangePoints(weeks: readonly WeekValue[]): ChangePoint[] {
  const sorted = [...weeks].sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime());
  const out: ChangePoint[] = [];
  let runDirection: "up" | "down" | null = null;
  for (let i = 4; i < sorted.length; i++) {
    const baseline = sorted.slice(i - 4, i).reduce((s, w) => s + w.avgActive, 0) / 4;
    const value = sorted[i]!.avgActive;
    const change = baseline >= MIN_BASELINE ? (value - baseline) / baseline : 0;
    const direction =
      change <= -CHANGE_THRESHOLD ? "down" : change >= CHANGE_THRESHOLD ? "up" : null;
    if (direction && direction !== runDirection) {
      out.push({
        weekStart: sorted[i]!.weekStart,
        direction,
        pct: Math.round(Math.abs(change) * 100),
        value: Math.round(value * 10) / 10,
        baseline: Math.round(baseline * 10) / 10,
      });
    }
    runDirection = direction;
  }
  return out;
}
