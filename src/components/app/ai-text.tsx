import type { Route } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { StarburstMark } from "@/components/app/starburst";
import { PRODUCT_NAME } from "@/config/product";

export interface AiTextSource {
  label: string;
  href: string | null;
  missing: boolean;
}

const PILL =
  "border-ask-pill-line bg-ask-pill inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium";

/**
 * The only way AI text reaches a screen (ARCHITECTURE §6.4, Rules 1 and 5): it renders a
 * SUCCEEDED run's items, each with its sources, the model's own confidence labelled as such,
 * and a link to what the run read. Any other status renders nothing at all.
 *
 * `variant="document"` is the Ask AI conversation look (Claude pattern): flowing text on the page
 * under a quiet byline, numbered source pills, one caption and a quiet "What it read" row. It
 * changes how the same content is drawn, never what is shown.
 */
export function AiText({
  run,
  items,
  emptyText,
  variant = "card",
}: {
  run: { id: string; status: string; confidence: number | null } | null;
  items: Array<{ text: string; sources: AiTextSource[] }>;
  emptyText?: string;
  variant?: "card" | "document";
}) {
  if (!run || run.status !== "SUCCEEDED") return null;
  const document = variant === "document";
  const confidence =
    run.confidence !== null
      ? ` · model confidence ${Math.round(run.confidence * 100)}% (the model's own estimate)`
      : "";
  return (
    <div className="space-y-2" data-testid="ai-text" data-run={run.id}>
      {document ? (
        <div className="flex items-center gap-2">
          <StarburstMark className="text-ask-accent size-5" />
          <span className="text-muted-foreground text-xs font-medium">{PRODUCT_NAME}</span>
        </div>
      ) : null}
      {items.length === 0 ? (
        <p className="text-sm">{emptyText ?? "Nothing here needs action."}</p>
      ) : (
        <ol className={document ? "space-y-5" : "space-y-3"}>
          {items.map((item, i) => (
            <li key={i} className="space-y-1" data-testid="ai-item">
              <p className={document ? "text-[15px] leading-7" : "text-sm"}>{item.text}</p>
              <ul
                className={
                  document
                    ? "flex flex-wrap gap-1.5 pt-2 text-xs"
                    : "flex flex-wrap gap-1.5 pt-1.5 text-xs"
                }
                aria-label="Sources"
                data-testid="ai-sources"
              >
                {item.sources.map((s, j) => {
                  const body = (
                    <>
                      {document ? (
                        <span className="text-ask-accent-text tabular-nums">{j + 1}</span>
                      ) : null}
                      {s.label}
                    </>
                  );
                  return (
                    <li key={j}>
                      {s.href ? (
                        <Link
                          href={s.href as Route}
                          className={
                            document
                              ? `${PILL} text-foreground hover:bg-ask-wash transition-colors`
                              : "border-border/70 bg-muted/50 hover:bg-muted text-foreground hover:text-primary inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors"
                          }
                        >
                          {body}
                        </Link>
                      ) : (
                        <span
                          className={
                            document
                              ? `${PILL} text-muted-foreground`
                              : "border-border/50 bg-muted/30 text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium"
                          }
                        >
                          {body}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {document ? (
        <div className="space-y-1 pt-1">
          <p className="text-muted-foreground text-xs">
            Written by AI from the records linked above{confidence}
          </p>
          <Link
            href={`/agent-runs/${run.id}` as Route}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-0.5 rounded text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            What it read
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          Written by AI from the records linked above
          {confidence}
          {" · "}
          <Link
            href={`/agent-runs/${run.id}` as Route}
            className="text-primary underline underline-offset-2"
          >
            What it read
          </Link>
        </p>
      )}
    </div>
  );
}
