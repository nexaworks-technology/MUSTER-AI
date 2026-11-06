import type { Route } from "next";
import Link from "next/link";

export interface AiTextSource {
  label: string;
  href: string | null;
  missing: boolean;
}

/**
 * The only way AI text reaches a screen (ARCHITECTURE §6.4, Rules 1 and 5): it renders a
 * SUCCEEDED run's items, each with its sources, the model's own confidence labelled as such,
 * and a link to what the run read. Any other status renders nothing at all.
 */
export function AiText({
  run,
  items,
  emptyText,
}: {
  run: { id: string; status: string; confidence: number | null } | null;
  items: Array<{ text: string; sources: AiTextSource[] }>;
  emptyText?: string;
}) {
  if (!run || run.status !== "SUCCEEDED") return null;
  return (
    <div className="space-y-2" data-testid="ai-text" data-run={run.id}>
      {items.length === 0 ? (
        <p className="text-sm">{emptyText ?? "Nothing here needs action."}</p>
      ) : (
        <ol className="space-y-3">
          {items.map((item, i) => (
            <li key={i} className="space-y-1" data-testid="ai-item">
              <p className="text-sm">{item.text}</p>
              <ul
                className="flex flex-wrap gap-x-3 gap-y-1 text-xs"
                aria-label="Sources"
                data-testid="ai-sources"
              >
                {item.sources.map((s, j) => (
                  <li key={j}>
                    {s.href ? (
                      <Link
                        href={s.href as Route}
                        className="text-primary underline underline-offset-2"
                      >
                        {s.label}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{s.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      <p className="text-muted-foreground text-xs">
        Written by AI from the records linked above
        {run.confidence !== null
          ? ` · model confidence ${Math.round(run.confidence * 100)}% (the model's own estimate)`
          : ""}
        {" · "}
        <Link
          href={`/agent-runs/${run.id}` as Route}
          className="text-primary underline underline-offset-2"
        >
          What it read
        </Link>
      </p>
    </div>
  );
}
