import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DuplicatePlayButton } from "@/components/app/play-actions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { listPlays } from "@/modules/plays/service";

export const metadata: Metadata = { title: "Plays" };

const STATUS_BADGES: Record<string, string> = {
  DRAFT: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  PUBLISHED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  PAUSED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  KILLED: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
};

export default async function PlaysPage() {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "accounts:view")) notFound();

  const plays = await listPlays(ctx);
  const canDraft = Boolean(can(ctx, "plays:createDraft"));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Plays</h1>
          <p className="text-muted-foreground text-sm">
            Automated workflows triggered by customer signals, milestones, and lifecycle events.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {plays.map((play) => (
          <Card key={play.id} className="flex flex-col justify-between">
            <CardHeader className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    STATUS_BADGES[play.status] ?? "bg-muted text-muted-foreground"
                  }`}
                >
                  {play.status}
                </span>
                <span className="text-xs text-muted-foreground">v{play.version}</span>
              </div>
              <CardTitle className="text-base font-medium">
                <Link
                  href={`/plays/${play.id}` as Route}
                  className="hover:underline focus:outline-none"
                >
                  {play.name}
                </Link>
              </CardTitle>
              {play.description && (
                <CardDescription className="line-clamp-2 text-xs">
                  {play.description}
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="pt-0 space-y-4">
              <div className="flex items-center justify-between text-xs text-muted-foreground border-t pt-3">
                <span>{play.category ?? "General"}</span>
                <span>{play.totalRuns} run{play.totalRuns === 1 ? "" : "s"}</span>
              </div>
              <div className="flex items-center justify-between pt-1">
                <Link
                  href={`/plays/${play.id}` as Route}
                  className="text-xs text-primary font-medium hover:underline"
                >
                  Inspect play →
                </Link>
                <DuplicatePlayButton playId={play.id} canDraft={canDraft} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
