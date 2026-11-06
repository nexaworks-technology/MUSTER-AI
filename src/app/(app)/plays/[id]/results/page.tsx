import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ComponentProps } from "react";
import { KillPlayButton } from "@/components/app/play-actions";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { getPlayResults } from "@/modules/plays/service";

export const metadata: Metadata = { title: "Play Results" };

type BadgeVariant = NonNullable<ComponentProps<typeof Badge>["variant"]>;

const RUN_VARIANTS = {
  COMPLETED: "success",
  RUNNING: "accent",
  WAITING: "warning",
} as const satisfies Record<string, BadgeVariant>;
const runVariant = (status: string): BadgeVariant =>
  (RUN_VARIANTS as Record<string, BadgeVariant>)[status] ?? "neutral";

const STATUS_BADGES: Record<string, BadgeVariant> = {
  DRAFT: "warning",
  PUBLISHED: "success",
  PAUSED: "accent",
  KILLED: "neutral",
};

function formatMoney(amountMinor: bigint | number | null | undefined): string {
  if (amountMinor === null || amountMinor === undefined) return "Hidden";
  const num = typeof amountMinor === "bigint" ? Number(amountMinor) / 100 : amountMinor / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(num);
}

export default async function PlayResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "accounts:view")) notFound();

  const { id } = await params;
  let results;
  try {
    results = await getPlayResults(ctx, id);
  } catch {
    notFound();
  }

  const { play, deadPlayStatus, stats, runs, skips } = results;
  const canPublish = Boolean(can(ctx, "plays:publish"));

  return (
    <div className="space-y-section">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Link href={"/plays" as Route} className="hover:underline">
          Plays
        </Link>
        <span>/</span>
        <Link href={`/plays/${play.id}` as Route} className="hover:underline">
          {play.name}
        </Link>
        <span>/</span>
        <span>Results</span>
      </div>

      <div className="border-border flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{play.name} Results</h1>
            <Badge variant={STATUS_BADGES[play.status] ?? "neutral"}>{play.status}</Badge>
            <Badge className="font-mono">v{play.version}</Badge>
          </div>
          <p className="text-muted-foreground text-sm">
            Performance metrics, executed actions, skips with reasons, and account history.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href={`/plays/${play.id}` as Route}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            ← Back to definition
          </Link>
          {(play.status === "PUBLISHED" || play.status === "PAUSED") && (
            <KillPlayButton playId={play.id} canPublish={canPublish} />
          )}
        </div>
      </div>

      {deadPlayStatus.isDead && (
        <div
          data-testid="dead-play-banner"
          className="border-danger/30 bg-danger-soft text-danger-soft-foreground rounded-lg border p-4"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                <span className="text-lg">⚠️</span>
                <span>Dead Play Detected</span>
              </div>
              <p className="mt-1 text-sm">{deadPlayStatus.message}</p>
              <p className="mt-1 text-xs">
                Note: Plays are never auto-killed. You can adjust the trigger criteria or kill this
                play to clean up.
              </p>
            </div>
            {canPublish && play.status !== "KILLED" && (
              <div className="mt-2 sm:mt-0">
                <KillPlayButton playId={play.id} canPublish={canPublish} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Accounts Entered</CardDescription>
            <CardTitle className="text-2xl font-bold">{stats.accountsEntered}</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-xs">
            Across {stats.totalRuns} total run{stats.totalRuns === 1 ? "" : "s"}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Actions Taken</CardDescription>
            <CardTitle className="text-2xl font-bold">{stats.actionsTaken}</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-xs">
            Tasks, notifications, drafts sent
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Skips</CardDescription>
            <CardTitle className="text-2xl font-bold">{stats.skipsCount}</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-xs">
            Frequency-capped or guarded steps
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Active / Waiting</CardDescription>
            <CardTitle className="text-2xl font-bold">
              {stats.openRuns} / {stats.waitingApprovals}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-xs">
            Open runs / awaiting approval
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Protected ARR</CardDescription>
            <CardTitle className="text-2xl font-bold">
              {formatMoney(stats.revenueProtectedMinor)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-xs">
            Entered accounts portfolio value
          </CardContent>
        </Card>
      </div>

      {/* Skips with Reasons */}
      <Card data-testid="skips-section">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-semibold">Skips with Reasons</CardTitle>
              <CardDescription className="text-xs">
                Steps skipped at runtime due to frequency caps or safety limits (never queued, never
                sent per D1).
              </CardDescription>
            </div>
            <Badge className="font-mono">{skips.length} recorded</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {skips.length === 0 ? (
            <p className="text-muted-foreground py-2 text-sm">
              No steps have been skipped. All active runs have passed runtime frequency and safety
              caps.
            </p>
          ) : (
            <div className="surface overflow-x-auto">
              <table className="w-full text-left text-sm" data-testid="skips-table">
                <thead>
                  <tr className="text-muted-foreground text-xs font-medium">
                    <th>Account</th>
                    <th>Step Key</th>
                    <th>Skip Reason</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {skips.map((skip) => (
                    <tr key={skip.id} className="text-xs">
                      <td className="font-medium">
                        <Link
                          href={`/accounts/${skip.accountId}` as Route}
                          className="text-primary hover:underline"
                        >
                          {skip.accountName}
                        </Link>
                      </td>
                      <td className="font-mono">{skip.stepKey}</td>
                      <td className="text-warning font-medium">{skip.skipReason}</td>
                      <td className="text-muted-foreground">
                        {new Date(skip.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Runs History */}
      <Card data-testid="runs-section">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base font-semibold">Execution History</CardTitle>
              <CardDescription className="text-xs">
                All accounts that entered this play and their current state.
              </CardDescription>
            </div>
            <Badge className="font-mono">{runs.length} runs</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="text-muted-foreground py-2 text-sm">
              No accounts have entered this play yet.
            </p>
          ) : (
            <div className="surface overflow-x-auto">
              <table className="w-full text-left text-sm" data-testid="runs-table">
                <thead>
                  <tr className="text-muted-foreground text-xs font-medium">
                    <th>Account</th>
                    <th>Tier</th>
                    <th>Status</th>
                    <th>Trigger Ref</th>
                    <th>Steps Executed</th>
                    <th>Entered</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className="text-xs">
                      <td className="font-medium">
                        <Link
                          href={`/accounts/${run.accountId}` as Route}
                          className="text-primary hover:underline"
                        >
                          {run.accountName}
                        </Link>
                      </td>
                      <td>{run.accountTier}</td>
                      <td>
                        <Badge variant={runVariant(run.status)}>{run.status}</Badge>
                        {run.exitReason && (
                          <span className="text-muted-foreground mt-0.5 block text-xs">
                            ({run.exitReason})
                          </span>
                        )}
                      </td>
                      <td className="text-muted-foreground font-mono text-xs">{run.triggerRef}</td>
                      <td className="font-mono">{run.stepCount}</td>
                      <td className="text-muted-foreground">
                        {new Date(run.enteredAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
