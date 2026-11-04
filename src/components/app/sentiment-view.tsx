import type { Route } from "next";
import Link from "next/link";
import { formatCalendarDate } from "@/lib/format";
import type { SentimentView } from "@/modules/sentiment/service";

const LABELS = [
  ["NEGATIVE", "Negative"],
  ["MIXED", "Mixed"],
  ["NEUTRAL", "Neutral"],
  ["POSITIVE", "Positive"],
] as const;
const SOURCES = [
  ["ticket", "Tickets"],
  ["email", "Emails"],
  ["call", "Calls"],
] as const;

/** Tone mix and themes with their quotes. Shown for the portfolio and for one account. */
export function SentimentPanel({
  view,
  themeHref,
  selectedTheme,
}: {
  view: SentimentView;
  /** Where a theme's own page is; null on a page that has none. */
  themeHref: ((theme: string) => string) | null;
  selectedTheme?: string | undefined;
}) {
  const { mix, themes } = view;
  return (
    <div className="space-y-6">
      <section aria-labelledby="mix-h" className="space-y-2">
        <h2 id="mix-h" className="text-lg font-medium">
          Tone of customer messages, last {view.days} days
        </h2>
        {mix.total === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="mix-empty">
            No tone has been read yet. It appears once the Watcher has read customer messages, each
            label with its quote.
          </p>
        ) : (
          <>
            <ul className="flex flex-wrap gap-3 text-sm" data-testid="mix">
              {LABELS.map(([k, label]) => (
                <li key={k} className="rounded-md border px-3 py-2">
                  <span className="block text-xl font-semibold">{mix.byLabel[k]}</span>
                  {label}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">
              Read from{" "}
              {SOURCES.map(([k, label]) => `${mix.bySource[k].count} ${label.toLowerCase()}`).join(
                ", ",
              )}
              . Only ticket tone feeds the health score; email and call tone is shown here and never
              scored.
            </p>
          </>
        )}
      </section>
      <section aria-labelledby="themes-h" className="space-y-2">
        <h2 id="themes-h" className="text-lg font-medium">
          Themes
        </h2>
        {themes.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="themes-empty">
            No themes yet. A theme appears when customers raise the same kind of problem, with the
            quotes that show it.
          </p>
        ) : (
          <ul
            className="divide-border border-border divide-y rounded-md border"
            data-testid="themes"
          >
            {themes.map((t) => (
              <li key={t.theme} className="space-y-1 p-3 text-sm" data-testid="theme">
                <p className="font-medium">
                  {themeHref && selectedTheme !== t.theme ? (
                    <Link href={themeHref(t.theme) as Route} className="underline">
                      {t.label}
                    </Link>
                  ) : (
                    t.label
                  )}{" "}
                  <span className="text-muted-foreground font-normal">
                    · {t.count} mention{t.count === 1 ? "" : "s"} across {t.accounts} account
                    {t.accounts === 1 ? "" : "s"}
                  </span>
                </p>
                <ul className="space-y-1">
                  {t.quotes.map((q, i) => (
                    <li key={i} data-testid="theme-quote">
                      <q>{q.quote}</q>{" "}
                      <span className="text-muted-foreground text-xs">
                        — {q.account.name},{" "}
                        {formatCalendarDate(new Date(`${q.date}T00:00:00Z`))}{" "}
                      </span>
                      <Link href={q.href as Route} className="text-xs underline">
                        open the source
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
