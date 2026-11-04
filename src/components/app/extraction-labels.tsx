import type { DisplayLabel } from "@/modules/conversations/service";

const TONE: Record<DisplayLabel["tone"], string> = {
  good: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  neutral: "bg-muted text-foreground",
  risk: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
  negative: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100",
  mixed: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-100",
};

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
          <span className={`inline-block rounded px-1.5 py-0.5 font-medium ${TONE[l.tone]}`}>
            {l.text}
          </span>{" "}
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
