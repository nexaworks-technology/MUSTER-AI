import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { KillPlayButton } from "@/components/app/play-actions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { getPlayResults } from "@/modules/plays/service";

export const metadata: Metadata = { title: "Play Results" };

const STATUS_BADGES: Record<string, string> = {
  DRAFT: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  PUBLISHED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  PAUSED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  KILLED: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
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

export default async function PlayResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
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
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
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

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between border-b pb-6">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{play.name} Results</h1>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                STATUS_BADGES[play.status] ?? "bg-muted text-muted-foreground"
              }`}
            >
              {play.status}
            </span>
            <span className="text-xs bg-muted px-2 py-0.5 rounded font-mono">
              v{play.version}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            Performance metrics, executed actions, skips with reasons, and account history.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href={`/plays/${play.id}` as Route}
            className="text-xs border rounded px-3 py-1.5 hover:bg-muted font-medium"
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
          className="rounded-lg border border-red-300 bg-red-50 p-4 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2 font-semibold">
                <span className="text-lg">⚠️</span>
                <span>Dead Play Detected</span>
              </div>
              <p className="mt-1 text-sm">{deadPlayStatus.message}</p>
              <p className="text-xs opacity-80 mt-1">
                Note: Plays are never auto-killed. You can adjust the trigger criteria or kill this play to clean up.
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
          <CardContent className="text-xs text-muted-foreground">
            Across {stats.totalRuns} total run{stats.totalRuns === 1 ? "" : "s"}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Actions Taken</CardDescription>
            <CardTitle className="text-2xl font-bold">{stats.actionsTaken}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Tasks, notifications, drafts sent
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">Skips</CardDescription>
            <CardTitle className="text-2xl font-bold">{stats.skipsCount}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
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
          <CardContent className="text-xs text-muted-foreground">
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
          <CardContent className="text-xs text-muted-foreground">
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
                Steps skipped at runtime due to frequency caps or safety limits (never queued, never sent per D1).
              </CardDescription>
            </div>
            <span className="text-xs font-mono bg-muted px-2 py-0.5 rounded">
              {skips.length} recorded
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {skips.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No steps have been skipped. All active runs have passed runtime frequency and safety caps.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" data-testid="skips-table">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground font-medium">
                    <th className="py-2 pr-4">Account</th>
                    <th className="py-2 pr-4">Step Key</th>
                    <th className="py-2 pr-4">Skip Reason</th>
                    <th className="py-2">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {skips.map((skip) => (
                    <tr key={skip.id} className="text-xs">
                      <td className="py-2.5 pr-4 font-medium">
                        <Link
                          href={`/accounts/${skip.accountId}` as Route}
                          className="hover:underline text-primary"
                        >
                          {skip.accountName}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4 font-mono">{skip.stepKey}</td>
                      <td className="py-2.5 pr-4 text-amber-800 dark:text-amber-300 font-medium">
                        {skip.skipReason}
                      </td>
                      <td className="py-2.5 text-muted-foreground">
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
            <span className="text-xs font-mono bg-muted px-2 py-0.5 rounded">
              {runs.length} runs
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No accounts have entered this play yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" data-testid="runs-table">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground font-medium">
                    <th className="py-2 pr-4">Account</th>
                    <th className="py-2 pr-4">Tier</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Trigger Ref</th>
                    <th className="py-2 pr-4">Steps Executed</th>
                    <th className="py-2">Entered</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {runs.map((run) => (
                    <tr key={run.id} className="text-xs">
                      <td className="py-2.5 pr-4 font-medium">
                        <Link
                          href={`/accounts/${run.accountId}` as Route}
                          className="hover:underline text-primary"
                        >
                          {run.accountName}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4">{run.accountTier}</td>
                      <td className="py-2.5 pr-4">
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            run.status === "COMPLETED"
                              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                              : run.status === "RUNNING"
                              ? "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200"
                              : run.status === "WAITING_APPROVAL"
                              ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {run.status}
                        </span>
                        {run.exitReason && (
                          <span className="block text-[10px] text-muted-foreground mt-0.5">
                            ({run.exitReason})
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-[11px] text-muted-foreground">
                        {run.triggerRef}
                      </td>
                      <td className="py-2.5 pr-4 font-mono">{run.stepCount}</td>
                      <td className="py-2.5 text-muted-foreground">
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
