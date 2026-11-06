import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import {
  PILOT_WEEK_OPTIONS,
  canViewPilotMetrics,
  listPilotRecords,
  loadPilotMetrics,
  pickFigure,
  pilotQuery,
  type PilotFigure,
  type PilotFigureKey,
  type PilotQuery,
} from "@/modules/reports/service";

export const metadata: Metadata = { title: "Pilot metrics" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const COLUMNS: Array<{ key: PilotFigureKey; head: string }> = [
  { key: "todayOpens", head: "Today opens" },
  { key: "approvalsOpens", head: "Approvals opens" },
  { key: "flagAcceptance", head: "Flag acceptance" },
  { key: "qbrPrepMedian", head: "QBR prep, median" },
  { key: "qbrPrepP90", head: "QBR prep, p90" },
  { key: "briefPrepMedian", head: "Brief prep, median" },
  { key: "briefPrepP90", head: "Brief prep, p90" },
];

const text = (f: PilotFigure) =>
  f.value === null
    ? "No data"
    : f.unit === "percent"
      ? `${f.value}%`
      : f.unit === "minutes"
        ? `${f.value} min`
        : String(f.value);

const href = (q: PilotQuery, member: string, figure: PilotFigureKey, week?: string): Route => {
  const p = new URLSearchParams({ weeks: String(q.weeks), member, figure });
  if (week) p.set("week", week);
  return `/reports/pilot-metrics?${p.toString()}#records` as Route;
};

function Cell({ f, to }: { f: PilotFigure; to: Route }) {
  return (
    <td className="py-1 pr-3 tabular-nums" title={f.value === null ? f.reason : undefined}>
      {f.value === null || f.sources.ids.length === 0 ? (
        <span className="text-muted-foreground">{text(f)}</span>
      ) : (
        <Link href={to} className="underline">
          {text(f)}
        </Link>
      )}
    </td>
  );
}

/**
 * Reports › Pilot metrics (spec §11, M12 B5): how each CSM used the product, for Admins and CS
 * Leaders judging a pilot. Every figure links to the ProductEvent records it was computed from.
 */
export default async function PilotMetricsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !canViewPilotMetrics(ctx)) notFound();
  const raw = Object.fromEntries(
    Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
  );
  const parsed = pilotQuery.safeParse(raw);
  const q = parsed.success ? parsed.data : pilotQuery.parse({});
  const metrics = await loadPilotMetrics(ctx, q);
  const picked = pickFigure(metrics, q);
  const records = picked ? await listPilotRecords(ctx, picked.figure.sources.ids) : null;
  const anyData = metrics.members.some((m) =>
    Object.values(m.period).some((f) => f.sources.ids.length > 0),
  );

  return (
    <div className="space-y-6">
      <div>
        <Link href={"/reports" as Route} className="text-muted-foreground text-sm hover:underline">
          ← Reports
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Pilot metrics</h1>
        <p className="text-muted-foreground text-sm">
          Weeks run Monday to Sunday ({ctx.workspace.timezone}). {metrics.periodStart} to{" "}
          {metrics.periodEnd}. Every figure links to the recorded events behind it.
        </p>
        <nav aria-label="Period" className="mt-2 flex gap-2 text-sm">
          {PILOT_WEEK_OPTIONS.map((w) => (
            <Link
              key={w}
              href={`/reports/pilot-metrics?weeks=${w}` as Route}
              aria-current={q.weeks === w ? "page" : undefined}
              className={`rounded-md px-3 py-1 ${q.weeks === w ? "bg-muted font-medium" : "hover:underline"}`}
            >
              Last {w} weeks
            </Link>
          ))}
        </nav>
      </div>

      <section aria-labelledby="defs" className="border-border space-y-1 rounded-md border p-3">
        <h2 id="defs" className="text-base font-semibold">
          What the words mean
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>
            <strong>Opens:</strong> times a person opened Today or Approvals, counted at most once
            every 30 minutes.
          </li>
          <li>
            <strong>Flag acceptance:</strong> flags a person acknowledged or approved a draft for,
            over those plus flags they marked false alarm. One verdict per flag.
          </li>
          <li>
            <strong>Prep time:</strong> minutes from a QBR or brief being generated to it being
            shared (a QBR is shared when it is locked for the customer portal), credited to the
            person who generated it and to the week it was shared. Briefs have no share step in the
            product yet, so brief prep time stays empty until one exists.
          </li>
        </ul>
      </section>

      {!anyData ? (
        <p className="text-sm" data-testid="pilot-empty">
          Nothing has been recorded in this period yet. Events start being recorded when people open
          Today and Approvals, act on flags, and generate or share QBRs and briefs. No figure here
          is estimated.
        </p>
      ) : null}

      <section aria-labelledby="period" className="space-y-2">
        <h2 id="period" className="text-lg font-semibold">
          Whole period, per person
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="pilot-period">
            <thead>
              <tr className="text-muted-foreground border-b text-left">
                <th className="py-1 pr-3 font-medium">Person</th>
                {COLUMNS.map((c) => (
                  <th key={c.key} className="py-1 pr-3 font-medium">
                    {c.head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metrics.members.map((m) => (
                <tr
                  key={m.membershipId}
                  className="border-b"
                  data-testid={`pilot-${m.membershipId}`}
                >
                  <td className="py-1 pr-3">{m.name}</td>
                  {COLUMNS.map((c) => (
                    <Cell key={c.key} f={m.period[c.key]} to={href(q, m.membershipId, c.key)} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {metrics.members.length === 0 ? (
          <p className="text-muted-foreground text-sm">No active CSMs in this workspace.</p>
        ) : null}
      </section>

      <section aria-labelledby="weekly" className="space-y-2">
        <h2 id="weekly" className="text-lg font-semibold">
          Week by week
        </h2>
        {metrics.members.map((m) => (
          <div key={m.membershipId} className="overflow-x-auto">
            <h3 className="text-sm font-medium">{m.name}</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-left">
                  <th className="py-1 pr-3 font-medium">Week</th>
                  {COLUMNS.map((c) => (
                    <th key={c.key} className="py-1 pr-3 font-medium">
                      {c.head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {metrics.weeks.map((w) => (
                  <tr key={w.label} className="border-b">
                    <td className="py-1 pr-3">
                      {w.label} <span className="text-muted-foreground">from {w.start}</span>
                    </td>
                    {COLUMNS.map((c) => (
                      <Cell
                        key={c.key}
                        f={m.weekly[w.label]![c.key]}
                        to={href(q, m.membershipId, c.key, w.label)}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      {picked && records ? (
        <section id="records" aria-labelledby="rec" className="space-y-2">
          <h2 id="rec" className="text-lg font-semibold">
            Records behind this number
          </h2>
          <p className="text-muted-foreground text-sm">
            {picked.member.name}, {picked.figure.label}
            {q.week ? `, ${q.week}` : ", whole period"}: {text(picked.figure)} ·{" "}
            <Link href={`/reports/pilot-metrics?weeks=${q.weeks}` as Route} className="underline">
              Clear
            </Link>
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-left">
                  <th className="py-1 pr-3 font-medium">When</th>
                  <th className="py-1 pr-3 font-medium">Event</th>
                  <th className="py-1 pr-3 font-medium">Record</th>
                  <th className="py-1 pr-3 font-medium">Details</th>
                  <th className="py-1 pr-3 font-medium">Event id</th>
                </tr>
              </thead>
              <tbody>
                {records.rows.map((r) => (
                  <tr key={r.id} className="border-b" data-testid="pilot-record">
                    <td className="py-1 pr-3">
                      {formatDateTime(r.occurredAt, ctx.workspace.timezone)}
                    </td>
                    <td className="py-1 pr-3">{r.name}</td>
                    <td className="py-1 pr-3">
                      {r.subjectType === "Approval" && r.subjectId ? (
                        <Link href={`/approvals/${r.subjectId}` as Route} className="underline">
                          Approval
                        </Link>
                      ) : r.subjectType ? (
                        `${r.subjectType} ${r.subjectId ?? ""}`
                      ) : (
                        "No record"
                      )}
                    </td>
                    <td className="py-1 pr-3">
                      {Object.entries(r.props)
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join(", ") || "None"}
                    </td>
                    <td className="text-muted-foreground py-1 pr-3 font-mono text-xs">{r.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {records.total > records.rows.length ? (
              <p className="text-muted-foreground text-xs">
                Showing the newest {records.rows.length} of {records.total} events.
              </p>
            ) : null}
          </div>
        </section>
      ) : q.member ? (
        <p className="text-muted-foreground text-sm">No records for that figure.</p>
      ) : null}
    </div>
  );
}
