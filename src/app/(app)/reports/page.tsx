import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DataListCard } from "@/components/app/data-list";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { canViewPilotMetrics, listReports } from "@/modules/reports/service";

export const metadata: Metadata = { title: "Reports" };

/**
 * Reports (spec §5): the seven pre-made reports, each a stored, dated snapshot whose figures link
 * to the records behind them, plus the Outcome Ledger and AI accuracy views.
 */
export default async function ReportsPage() {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "reports:view")) notFound();
  const reports = await listReports(ctx);
  const scope = can(ctx, "reports:view")!.scope;
  return (
    <div className="space-y-section">
      <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
      <p className="text-muted-foreground text-sm">
        Every report is stored when it is generated, with the date, and every figure links to the
        records it was computed from.
        {scope === "ALL"
          ? ""
          : " You see your own accounts only; money is shown only if you have revenue access."}
      </p>

      <section aria-labelledby="premade-h" className="space-y-3">
        <h2 id="premade-h" className="text-base font-semibold">
          Pre-made reports
        </h2>
        <DataListCard>
          <ul className="divide-border divide-y">
            {reports.map((r) => (
              <li key={r.key} className="flex flex-wrap items-baseline justify-between gap-3 p-4 hover:bg-muted/40 transition-colors">
                <div>
                  <Link
                    href={`/reports/${r.key}` as Route}
                    className="font-medium text-foreground hover:underline"
                  >
                    {r.title}
                  </Link>
                  <p className="text-muted-foreground text-xs mt-0.5">{r.description}</p>
                </div>
                <p className="text-muted-foreground text-xs shrink-0 tabular-nums" data-testid={`latest-${r.key}`}>
                  {r.latest
                    ? `Last generated ${formatDateTime(r.latest.generatedAt, ctx.workspace.timezone)}`
                    : "Not generated yet"}
                </p>
              </li>
            ))}
          </ul>
        </DataListCard>
      </section>

      {scope === "ALL" ? (
        <p className="text-sm">
          <Link
            href={"/reports/digest" as Route}
            className="text-primary underline underline-offset-2 font-medium"
          >
            Weekly digest
          </Link>{" "}
          <span className="text-muted-foreground text-xs">
            The AI&apos;s short summary of this week&apos;s reports, with links to each figure.
          </span>
        </p>
      ) : null}

      <section aria-labelledby="proof-h" className="space-y-3">
        <h2 id="proof-h" className="text-base font-semibold">
          Did it work?
        </h2>
        <DataListCard>
          <ul className="divide-border divide-y">
            <li className="p-4 hover:bg-muted/40 transition-colors">
              <Link
                href={"/reports/outcomes" as Route}
                className="font-medium text-foreground hover:underline"
              >
                Outcome Ledger
              </Link>
              <p className="text-muted-foreground text-xs mt-0.5">
                What happened to the accounts the AI flagged, and the money attributed to acting.
              </p>
            </li>
            <li className="p-4 hover:bg-muted/40 transition-colors">
              <Link
                href={"/reports/ai-accuracy" as Route}
                className="font-medium text-foreground hover:underline"
              >
                AI accuracy
              </Link>
              <p className="text-muted-foreground text-xs mt-0.5">
                How often each rule was right, and which ones cry wolf.
              </p>
            </li>
            {canViewPilotMetrics(ctx) ? (
              <li className="p-4 hover:bg-muted/40 transition-colors">
                <Link
                  href={"/reports/pilot-metrics" as Route}
                  className="font-medium text-foreground hover:underline"
                >
                  Pilot metrics
                </Link>
                <p className="text-muted-foreground text-xs mt-0.5">
                  How each CSM uses the product: Today and Approvals opens, flag acceptance and QBR
                  prep time, week by week.
                </p>
              </li>
            ) : null}
          </ul>
        </DataListCard>
      </section>
    </div>
  );
}
