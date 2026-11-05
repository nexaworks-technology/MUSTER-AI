import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { listReports } from "@/modules/reports/service";

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
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Reports</h1>
      <p className="text-muted-foreground text-sm">
        Every report is stored when it is generated, with the date, and every figure links to the
        records it was computed from.
        {scope === "ALL"
          ? ""
          : " You see your own accounts only; money is shown only if you have revenue access."}
      </p>

      <section aria-labelledby="premade-h" className="space-y-2">
        <h2 id="premade-h" className="text-lg font-semibold">
          Pre-made reports
        </h2>
        <ul className="divide-border divide-y rounded-md border">
          {reports.map((r) => (
            <li key={r.key} className="flex flex-wrap items-baseline justify-between gap-2 p-3">
              <div>
                <Link
                  href={`/reports/${r.key}` as Route}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {r.title}
                </Link>
                <p className="text-muted-foreground text-sm">{r.description}</p>
              </div>
              <p className="text-muted-foreground text-xs" data-testid={`latest-${r.key}`}>
                {r.latest
                  ? `Last generated ${formatDateTime(r.latest.generatedAt, ctx.workspace.timezone)}`
                  : "Not generated yet"}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="proof-h" className="space-y-2">
        <h2 id="proof-h" className="text-lg font-semibold">
          Did it work?
        </h2>
        <ul className="divide-border divide-y rounded-md border">
          <li className="p-3">
            <Link
              href={"/reports/outcomes" as Route}
              className="font-medium underline-offset-2 hover:underline"
            >
              Outcome Ledger
            </Link>
            <p className="text-muted-foreground text-sm">
              What happened to the accounts the AI flagged, and the money attributed to acting.
            </p>
          </li>
          <li className="p-3">
            <Link
              href={"/reports/ai-accuracy" as Route}
              className="font-medium underline-offset-2 hover:underline"
            >
              AI accuracy
            </Link>
            <p className="text-muted-foreground text-sm">
              How often each rule was right, and which ones cry wolf.
            </p>
          </li>
        </ul>
      </section>
    </div>
  );
}
