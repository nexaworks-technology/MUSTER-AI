import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ComponentProps } from "react";
import { DuplicatePlayButton } from "@/components/app/play-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { listPlays } from "@/modules/plays/service";

export const metadata: Metadata = { title: "Plays" };

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;

const STATUS_BADGES: Record<string, BadgeVariant> = {
  DRAFT: "warning",
  PUBLISHED: "success",
  PAUSED: "accent",
  KILLED: "neutral",
};

export default async function PlaysPage() {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "accounts:view")) notFound();

  const plays = await listPlays(ctx);
  const canDraft = Boolean(can(ctx, "plays:createDraft"));

  return (
    <div className="space-y-section">
      {/* Subnav Tabs */}
      <div className="border-border border-b">
        <div className="flex gap-4">
          <Link
            href={"/plays" as Route}
            className="text-foreground border-primary border-b-2 pb-3 text-sm font-medium"
          >
            Plays
          </Link>
          <Link
            href={"/campaigns" as Route}
            className="text-muted-foreground hover:text-foreground border-b-2 border-transparent pb-3 text-sm font-medium"
          >
            Campaigns
          </Link>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Plays</h1>
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
                <Badge variant={STATUS_BADGES[play.status] ?? "neutral"}>{play.status}</Badge>
                <span className="text-muted-foreground text-xs">v{play.version}</span>
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
            <CardContent className="space-y-4 pt-0">
              <div className="text-muted-foreground flex items-center justify-between border-t pt-3 text-xs">
                <span>{play.category ?? "General"}</span>
                <span>
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
        ))}
      </div>
    </div>
  );
}
