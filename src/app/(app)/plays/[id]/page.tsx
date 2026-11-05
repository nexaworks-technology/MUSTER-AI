import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  DuplicatePlayButton,
  KillPlayButton,
  PausePlayButton,
  PublishPlayControl,
  RevertVersionButton,
} from "@/components/app/play-actions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { getPlay, previewRetroactiveAccounts, validatePlaySafety } from "@/modules/plays/service";

export const metadata: Metadata = { title: "Inspect Play" };

const STATUS_BADGES: Record<string, string> = {
  DRAFT: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  PUBLISHED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  PAUSED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  KILLED: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
};

export default async function InspectPlayPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "accounts:view")) notFound();

  const { id } = await params;
  let play;
  try {
    play = await getPlay(ctx, id);
  } catch {
    notFound();
  }

  const canPublish = Boolean(can(ctx, "plays:publish"));
  const canDraft = Boolean(can(ctx, "plays:createDraft"));

  // Check matching accounts for retroactive entry
  const retroactivePreview = await previewRetroactiveAccounts(ctx, play.id);

  // Live safety check
  let safetyResult = null;
  if (play.definition) {
    safetyResult = await validatePlaySafety(play.definition);
  }

  return (
    <div className="space-y-6">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Link href={"/plays" as Route} className="hover:underline">
          Plays
        </Link>
        <span>/</span>
        <span>{play.name}</span>
      </div>

      <div className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{play.name}</h1>
            <span
              className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                STATUS_BADGES[play.status] ?? "bg-muted text-muted-foreground"
              }`}
            >
              {play.status}
            </span>
            <span className="bg-muted rounded px-2 py-0.5 font-mono text-xs">
              v{play.latestVersion?.version ?? 1}
            </span>
            {play.isSeeded && (
              <span className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                Seeded
              </span>
            )}
          </div>
          {play.description && <p className="text-muted-foreground text-sm">{play.description}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/plays/${play.id}/results` as Route}
            className="hover:bg-muted inline-flex items-center gap-1 rounded border px-3 py-1.5 text-xs font-medium"
          >
            📊 View Results
          </Link>
          <Link
            href={`/reports/outcomes?play=${encodeURIComponent(play.key)}` as Route}
            className="hover:bg-muted inline-flex items-center gap-1 rounded border px-3 py-1.5 text-xs font-medium"
          >
            Results
          </Link>
          {play.status === "PUBLISHED" && (
            <PausePlayButton playId={play.id} canPublish={canPublish} />
          )}
          {(play.status === "PUBLISHED" || play.status === "PAUSED") && (
            <KillPlayButton playId={play.id} canPublish={canPublish} />
          )}
          <DuplicatePlayButton playId={play.id} canDraft={canDraft} />
        </div>
      </div>

      {(play.status === "DRAFT" || play.status === "PAUSED") && (
        <PublishPlayControl
          playId={play.id}
          canPublish={canPublish}
          matchingAccountsCount={retroactivePreview.count}
        />
      )}

      {safetyResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              <span>Safety Check</span>
              {safetyResult.passed ? (
                <span className="inline-flex items-center rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                  Safe to publish
                </span>
              ) : (
                <span className="inline-flex items-center rounded bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800 dark:bg-rose-950 dark:text-rose-200">
                  Refused ({safetyResult.refusals.length})
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {safetyResult.passed ? (
              <p className="text-muted-foreground text-sm">
                All pre-publish safety checks passed. Step approvals, caps, and merge templates
                conform to workspace policy.
              </p>
            ) : (
              <ul className="text-destructive list-disc space-y-1 pl-5 text-sm">
                {safetyResult.refusals.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What This Play Does</CardTitle>
          <CardDescription>
            Plain-language explanation of triggers, conditions, and actions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted/40 rounded-lg p-4 font-mono text-xs whitespace-pre-wrap">
            {play.summary || "No definition available."}
          </pre>
        </CardContent>
      </Card>

      {play.definition?.branches && play.definition.branches.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tier Branches</CardTitle>
            <CardDescription>
              Different actions taken based on account segment or tier.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {play.definition.branches.map((branch, idx) => (
              <div key={idx} className="space-y-2 rounded-md border p-4">
                <div className="text-sm font-semibold">Branch: {branch.tier ?? "Default"}</div>
                <div className="space-y-1">
                  {branch.steps.map((step, sIdx) => (
                    <div
                      key={sIdx}
                      className="text-muted-foreground flex items-center justify-between border-b pb-1 text-xs"
                    >
                      <span>
                        {sIdx + 1}. {step.name} ({step.handler})
                      </span>
                      <span className="font-mono">
                        {step.approvalLevelByTier?.[branch.tier ?? "HIGH_TOUCH"] ?? "DEFAULT"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Version History</CardTitle>
            <CardDescription>Audited revisions of this play.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {play.versions.map((v) => (
                <div key={v.id} className="flex items-center justify-between border-b pb-2 text-xs">
                  <div>
                    <span className="font-semibold">v{v.version}</span>
                    {v.publishedAt ? (
                      <span className="text-muted-foreground ml-2">
                        Published {new Date(v.publishedAt).toLocaleDateString()}
                        {v.publishedBy
                          ? ` by ${v.publishedBy.user.name ?? v.publishedBy.user.email}`
                          : ""}
                      </span>
                    ) : (
                      <span className="ml-2 font-medium text-amber-800 dark:text-amber-300">
                        Draft
                      </span>
                    )}
                  </div>
                  {v.version !== play.latestVersion?.version && (
                    <RevertVersionButton playId={play.id} version={v.version} canDraft={canDraft} />
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Runs</CardTitle>
            <CardDescription>
              {play.totalRuns} total account run{play.totalRuns === 1 ? "" : "s"}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {play.runs.length === 0 ? (
              <p className="text-muted-foreground text-xs">No runs yet.</p>
            ) : (
              <div className="space-y-2">
                {play.runs.map((run) => (
                  <div
                    key={run.id}
                    className="flex items-center justify-between border-b pb-2 text-xs"
                  >
                    <div>
                      <div className="font-medium">{run.account.name}</div>
                      <div className="text-muted-foreground font-mono text-[10px]">
                        {run.triggerRef}
                      </div>
                    </div>
                    <div className="text-right">
                      <span
                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          run.status === "COMPLETED"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                            : run.status === "RUNNING"
                              ? "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200"
                              : run.status === "WAITING"
                                ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                                : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {run.status}
                      </span>
                      <div className="text-muted-foreground text-[10px]">
                        {new Date(run.enteredAt).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
