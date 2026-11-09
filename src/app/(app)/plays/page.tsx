import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DuplicatePlayButton } from "@/components/app/play-actions";
import { StatusPill } from "@/components/app/status-pill";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { listPlays } from "@/modules/plays/service";

export const metadata: Metadata = { title: "Plays" };

export default async function PlaysPage() {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "accounts:view")) notFound();

  const plays = await listPlays(ctx);
  const canDraft = Boolean(can(ctx, "plays:createDraft"));

  return (
    <div className="space-y-section">
      {/* Subnav Tabs */}
      <nav aria-label="Plays sections" className="border-b border-border/80">
        <ul className="flex gap-1 text-xs sm:text-sm">
          <li>
            <Link
              href={"/plays" as Route}
              aria-current="page"
              className="border-primary text-primary font-semibold bg-primary/[0.04] inline-block rounded-t-lg border-b-2 px-3.5 py-2.5 whitespace-nowrap outline-none"
            >
              Plays
            </Link>
          </li>
          <li>
            <Link
              href={"/campaigns" as Route}
              className="text-muted-foreground hover:border-border/60 hover:text-foreground border-transparent inline-block rounded-t-lg border-b-2 px-3.5 py-2.5 whitespace-nowrap outline-none transition-colors"
            >
              Campaigns
            </Link>
          </li>
        </ul>
      </nav>

      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Plays</h1>
          <p className="text-muted-foreground text-sm">
            Automated workflows triggered by customer signals, milestones, and lifecycle events.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {plays.map((play) => {
          const pillVariant =
            play.status === "PUBLISHED"
              ? "success"
              : play.status === "DRAFT"
                ? "warning"
                : play.status === "PAUSED"
                  ? "accent"
                  : "neutral";
          return (
            <Card key={play.id} className="surface-interactive flex flex-col justify-between border-border/80 rounded-xl shadow-xs transition-all hover:shadow-sm">
              <CardHeader className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <StatusPill variant={pillVariant} size="sm">
                    {play.status}
                  </StatusPill>
                  <span className="text-muted-foreground text-xs tabular-nums">v{play.version}</span>
                </div>
                <CardTitle className="text-base font-medium">
                  <Link
                    href={`/plays/${play.id}` as Route}
                    className="hover:underline focus:outline-none text-foreground"
                  >
                    {play.name}
                  </Link>
                </CardTitle>
                {play.description && (
                  <CardDescription className="line-clamp-2 text-xs leading-relaxed">
                    {play.description}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-4 pt-0">
                <div className="text-muted-foreground flex items-center justify-between border-t border-border/60 pt-3 text-xs">
                  <span>{play.category ?? "General"}</span>
                  <span className="tabular-nums">
                    {play.totalRuns} run{play.totalRuns === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <Link
                    href={`/plays/${play.id}` as Route}
                    className="text-primary text-xs font-medium hover:underline"
                  >
                    Inspect play →
                  </Link>
                  <DuplicatePlayButton playId={play.id} canDraft={canDraft} />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
