import type { Metadata } from "next";
import { EmptyState } from "@/components/app/empty-state";
import { LineChart } from "@/components/app/line-chart";
import { formatCalendarDate } from "@/lib/format";
import { getUsage } from "@/modules/usage/service";
import { sourceLabel } from "@/modules/integrations/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Usage" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function UsagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  // A health reason links here with ?from=&to= (calendar days): those weeks are highlighted.
  const q = await searchParams;
  const from = one(q.from);
  const to = one(q.to);
  const window = from && to && DAY.test(from) && DAY.test(to) && from <= to ? { from, to } : null;
  // Usage dates are calendar days (UTC), so they are shown without a time-zone shift.
  const { ctx, account } = await loadAccount(id);
  const usage = await getUsage(ctx, account.id, new Date(), window ?? undefined);
  // Counts below follow the reason's window when there is one, so the proof shows its number.
  const span = usage.period
    ? `from ${formatCalendarDate(new Date(`${usage.period.from}T00:00:00Z`))} to ${formatCalendarDate(new Date(`${usage.period.to}T00:00:00Z`))}`
    : "in the last 28 days";

  if (!usage.hasData) {
    return (
      <div className="surface space-y-2 p-5" data-testid="no-usage">
        <h2 className="text-base font-semibold">No usage data yet</h2>
        <p className="text-muted-foreground text-sm">
          No product usage has been recorded for this account. Usage appears here once it is
          imported or connected.
        </p>
      </div>
    );
  }

  const metricLabel =
    usage.metric === "distinct-users" ? "Weekly active people" : "Peak daily active users";
  const points = usage.weekly.map((w) => ({
    label: new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(w.weekStart),
    value: w.activeUsers,
    highlight: window ? inWindow(w.weekStart, window) : false,
  }));
  const shown = points.filter((p) => p.highlight).length;
  const keyUnused = usage.features.filter((f) => f.inPlan && f.isKey && f.daysUsed28d === 0);

  return (
    <div className="space-y-section">
      <section aria-labelledby="usage-chart" className="surface space-y-3 p-5">
        <h2 id="usage-chart" className="text-base font-semibold">
          {metricLabel}, last {points.length} weeks
        </h2>
        {usage.lastSource && sourceLabel(usage.lastSource) ? (
          <p className="text-muted-foreground text-xs" data-testid="usage-source">
            Usage {sourceLabel(usage.lastSource)}.
          </p>
        ) : null}
        {window ? (
          <p
            className="bg-accent text-accent-foreground rounded-md px-3 py-2 text-sm"
            data-testid="usage-window"
            role="note"
          >
            Shaded: the window a health reason points to (
            {formatCalendarDate(new Date(`${window.from}T00:00:00Z`))} –{" "}
            {formatCalendarDate(new Date(`${window.to}T00:00:00Z`))}).
            {shown === 0
              ? " None of it falls inside the weeks shown here."
              : usage.weekly.length > 0 &&
                  window.from < usage.weekly[0]!.weekStart.toISOString().slice(0, 10)
                ? " Part of it is earlier than the weeks shown here."
                : ""}
          </p>
        ) : null}
        {points.length > 0 ? (
          <LineChart points={points} valueLabel={metricLabel} />
        ) : (
          <EmptyState>No activity in the last 13 weeks.</EmptyState>
        )}
        <details className="text-sm">
          <summary className="text-muted-foreground cursor-pointer">Show the numbers</summary>
          <table className="mt-2 w-full max-w-sm text-sm">
            <caption className="sr-only">{metricLabel} by week</caption>
            <thead>
              <tr>
                <th scope="col">Week of</th>
                <th scope="col" className="text-right">
                  {metricLabel}
                </th>
              </tr>
            </thead>
            <tbody>
              {usage.weekly.map((w, i) => (
                <tr
                  key={i}
                  className={
                    window && inWindow(w.weekStart, window) ? "bg-muted font-medium" : undefined
                  }
                >
                  <td>{formatCalendarDate(w.weekStart)}</td>
                  <td className="text-right">{w.activeUsers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        <p className="text-muted-foreground text-sm">
          Last activity:{" "}
          {usage.lastActiveDate ? formatCalendarDate(usage.lastActiveDate) : "none recorded"}
        </p>
      </section>

      <section aria-labelledby="seats" className="surface space-y-2 p-5 text-sm">
        <h2 id="seats" className="text-base font-semibold">
          Seats
        </h2>
        <p data-testid="seats">
          {usage.activeUsers28d !== null
            ? `${usage.activeUsers28d} people active ${span}`
            : "No person-level usage recorded"}
          {" · "}
          {usage.seatsPurchased !== null
            ? `${usage.seatsPurchased} seats bought`
            : "seats bought not on file"}
          {usage.activeUsers28d !== null &&
          usage.seatsPurchased !== null &&
          usage.activeUsers28d > usage.seatsPurchased
            ? ` · ${usage.activeUsers28d - usage.seatsPurchased} more people than seats`
            : ""}
        </p>
      </section>

      <section aria-labelledby="features" className="space-y-3">
        <h2 id="features" className="text-base font-semibold">
          Features in their plan ({usage.period ? span : "last 28 days"})
        </h2>
        {keyUnused.length > 0 ? (
          <p className="text-sm">
            {keyUnused.length} key feature{keyUnused.length > 1 ? "s" : ""} in their plan{" "}
            {keyUnused.length > 1 ? "have" : "has"} not been used {span}:{" "}
            {keyUnused.map((f) => f.label).join(", ")}.
          </p>
        ) : null}
        <ul className="surface divide-border divide-y overflow-hidden text-sm">
          {usage.features.map((f) => (
            <li key={f.key} className="flex justify-between gap-2 p-4">
              <span>
                {f.label}
                {f.isKey ? <span className="text-muted-foreground"> · key feature</span> : null}
                {!f.inPlan ? (
                  <span className="text-muted-foreground"> · not in their plan</span>
                ) : null}
              </span>
              <span className="text-muted-foreground">
                {f.daysUsed28d === 0
                  ? "not used"
                  : `used on ${f.daysUsed28d} day${f.daysUsed28d > 1 ? "s" : ""}`}
                {f.lastUsed ? ` · last ${formatCalendarDate(f.lastUsed)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="top-users" className="space-y-3">
        <h2 id="top-users" className="text-base font-semibold">
          Most active people ({usage.period ? span : "last 28 days"})
        </h2>
        {usage.topUsers.length === 0 ? (
          <EmptyState>No person-level activity {span}.</EmptyState>
        ) : (
          <ol className="surface divide-border divide-y overflow-hidden text-sm">
            {usage.topUsers.map((u) => (
              <li key={u.externalUserId} className="flex justify-between gap-2 p-4">
                <span>
                  {u.name ?? (
                    <span className="text-muted-foreground">
                      Unnamed user ({u.externalUserId.split(":").at(-1)})
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {u.events} actions · {u.daysActive} days
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/** A week (Monday start, 7 days) overlaps the reason's window. */
function inWindow(weekStart: Date, w: { from: string; to: string }): boolean {
  const start = weekStart.toISOString().slice(0, 10);
  const end = new Date(weekStart.getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
  return start <= w.to && end >= w.from;
}
