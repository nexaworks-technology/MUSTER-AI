import type { Metadata, Route } from "next";
import Link from "next/link";
import { SentimentPanel } from "@/components/app/sentiment-view";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { getSentiment } from "@/modules/sentiment/service";

export const metadata: Metadata = { title: "Sentiment & themes" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Health › Sentiment & themes (spec §6E1): tone and recurring problems across the portfolio, with quotes and sources. */
export default async function SentimentPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = (await resolveWorkspaceContext(await requireSession()))!;
  const sp = await searchParams;
  const theme = Array.isArray(sp.theme) ? sp.theme[0] : sp.theme;
  const view = await getSentiment(ctx, {
    ...(theme && /^[a-z][a-z0-9_]{0,40}$/.test(theme) ? { theme } : {}),
  });
  return (
    <div className="space-y-section">
      <div className="space-y-1">
        <Link href={"/health" as Route} className="text-muted-foreground text-sm hover:underline">
          ← Health
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Sentiment &amp; themes</h1>
        <p className="text-muted-foreground text-sm">
          What customers say, counted by code from labels the Watcher read. Every label and theme
          shows the exact words behind it and a link to where they were said.
        </p>
      </div>
      {theme ? (
        <p className="bg-accent text-accent-foreground rounded-md px-3 py-2 text-sm">
          Showing every quote for one theme.{" "}
          <Link
            href={"/health/sentiment" as Route}
            className="font-medium underline underline-offset-2"
          >
            Back to all themes
          </Link>
        </p>
      ) : null}
      <SentimentPanel
        view={view}
        themeHref={(t) => `/health/sentiment?theme=${t}`}
        selectedTheme={theme}
      />
    </div>
  );
}
