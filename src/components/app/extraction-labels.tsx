import { Badge } from "@/components/ui/badge";
import type { DisplayLabel } from "@/modules/conversations/service";

const TONE = {
  good: "success",
  neutral: "neutral",
  risk: "warning",
  negative: "danger",
  mixed: "neutral",
} as const satisfies Record<DisplayLabel["tone"], "success" | "neutral" | "warning" | "danger">;

/**
 * What the Watcher read, each label next to the exact words that prove it (Rule 1). The label is
 * the model's; the quote was checked word for word against the source before it was stored.
 */
export function ExtractionLabels({
  labels,
}: {
  labels: ReadonlyArray<DisplayLabel & { quote: string }>;
}) {
  if (labels.length === 0) return null;
  return (
    <ul
      className="mt-1 flex flex-col gap-1"
      aria-label="What was read from this"
      data-testid="labels"
    >
      {labels.map((l, i) => (
        <li key={`${l.kind}-${i}`} className="text-xs">
          <Badge variant={TONE[l.tone]}>{l.text}</Badge>{" "}
          <q className="text-muted-foreground">
            <mark className="text-foreground bg-transparent underline decoration-dotted">
              {l.quote}
            </mark>
          </q>
        </li>
      ))}
    </ul>
  );
}
