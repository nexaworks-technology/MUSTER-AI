import type { Figure, ReportContent } from "../types";

/** The one figure with this label (throws when absent or ambiguous, so tests stay honest). */
export function fig(content: ReportContent, label: string): Figure {
  const all = content.sections.flatMap((s) => s.figures).filter((f) => f.label === label);
  if (all.length !== 1) throw new Error(`expected one figure "${label}", found ${all.length}`);
  return all[0]!;
}

export const labels = (content: ReportContent): string[] =>
  content.sections.flatMap((s) => s.figures.map((f) => f.label));

/** Every figure in the report must say where it came from or why it has no value. */
export function everyFigureIsProven(content: ReportContent): void {
  for (const f of content.sections.flatMap((s) => s.figures)) {
    if (f.value === null) {
      if (!f.reason) throw new Error(`"${f.label}" has no value and no reason`);
    } else if (f.sources.ids.length === 0 && f.unit !== "count") {
      throw new Error(`"${f.label}" has a value but no source records`);
    }
  }
}
