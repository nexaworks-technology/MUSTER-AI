import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AiText } from "@/components/app/ai-text";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { getLatestDigest } from "@/modules/reports/service";

export const metadata: Metadata = { title: "Weekly digest" };

/**
 * The latest weekly digest (M11 S7): written by the Leader Reporter from the week's computed report
 * figures, every sentence with links to the figures it uses. Only a SUCCEEDED run is rendered
 * (<AiText>); a week without one says so and points to the reports. Leaders only: it covers the
 * whole workspace.
 */
export default async function DigestPage() {
  const ctx = await resolveWorkspaceContext(await requireSession());
  const grant = ctx ? can(ctx, "reports:view") : null;
  if (!ctx || !grant || grant.scope !== "ALL") notFound();
  const digest = await getLatestDigest(ctx);
  return (
    <div className="space-y-section max-w-3xl">
      <div>
        <Link href="/reports" className="text-muted-foreground text-sm underline">
          Reports
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Weekly digest</h1>
      </div>
      {digest ? (
        <section className="space-y-3" data-testid="weekly-digest">
          <p className="text-muted-foreground text-sm">
            Week of {digest.weekStart}
            {digest.run.finishedAt
              ? `, written ${formatDateTime(digest.run.finishedAt, ctx.workspace.timezone)}`
              : ""}
            . It covers the whole workspace and contains no revenue figures; money is in the linked
            reports for people with revenue access.
          </p>
          <AiText
            run={digest.run}
            items={digest.items}
            emptyText="The week's reports have nothing to report."
          />
          {digest.latestAttempt ? (
            <p className="text-muted-foreground text-sm" data-testid="digest-latest-failed">
              A newer digest could not be written; the reports are ready on the{" "}
              <Link
                href={"/reports" as Route}
                className="text-primary underline underline-offset-2"
              >
                Reports
              </Link>{" "}
              page.
            </p>
          ) : null}
        </section>
      ) : (
        <p className="text-muted-foreground text-sm" data-testid="digest-empty">
          No weekly digest has been written yet. One is written each Monday morning from the
          week&apos;s reports; if it cannot be written you are told, and the reports are still ready
          on the{" "}
          <Link href={"/reports" as Route} className="text-primary underline underline-offset-2">
            Reports
          </Link>{" "}
          page.
        </p>
      )}
    </div>
  );
}
