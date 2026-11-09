import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { DataListAvatar, DataListCard } from "@/components/app/data-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatMoney } from "@/lib/money";
import { getRevenueView, type CurrencyWaterfall } from "@/modules/revenue/service";

export const metadata: Metadata = { title: "Revenue" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const m = (minor: bigint, currency: string) => formatMoney({ minor, currency });
const MONTHS = /^(\d{4})-(\d{2})$/;
const monthLabel = (s: string) => {
  const [, y, mo] = MONTHS.exec(s)!;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(Number(y), Number(mo) - 1, 1)));
};

function Waterfall({ w }: { w: CurrencyWaterfall }) {
  const lines: Array<[string, bigint, number]> = [
    ["Opening ARR", w.openingMinor, 0],
    ["New", w.new.amountMinor, w.new.eventIds.length],
    ["Expansion", w.expansion.amountMinor, w.expansion.eventIds.length],
    ["Contraction", w.contraction.amountMinor, w.contraction.eventIds.length],
    ["Churn", w.churn.amountMinor, w.churn.eventIds.length],
    ["Reactivation", w.reactivation.amountMinor, w.reactivation.eventIds.length],
    ["Closing ARR", w.closingMinor, 0],
  ];
  return (
    <table className="text-left text-sm" data-testid={`waterfall-${w.currency}`}>
      <caption className="text-left font-medium text-foreground mb-1">{w.currency}</caption>
      <tbody>
        {lines.map(([label, amount, n]) => (
          <tr key={label} className="border-b border-border/40 last:border-b-0">
            <th scope="row" className="font-normal py-1 pr-4 text-muted-foreground">
              {label}
            </th>
            <td className="tabular-nums font-medium py-1 pr-4 text-foreground">{m(amount, w.currency)}</td>
            <td className="text-muted-foreground text-xs py-1">
              {n ? `${n} event${n === 1 ? "" : "s"}` : ""}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={3} className="text-muted-foreground text-xs pt-2">
            {w.reconciled
              ? "Opening plus movements equals closing, checked against the sum of every event."
              : "Does not reconcile: see the events listed under each movement."}
            {w.anomalies.length
              ? ` ${w.anomalies.length} event(s) have a sign that does not match their type.`
              : ""}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

/**
 * Revenue (spec §6N): the ARR waterfall for a period, expected billing, money at risk, coverage
 * and team load. All of it needs revenue access; without it the route is a 404.
 */
export default async function RevenuePage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "revenue:view")) notFound();
  const p = await searchParams;
  const parsed = z
    .object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
    .safeParse({
      from: one(p.from) || undefined,
      to: one(p.to) || undefined,
    });
  const q = parsed.success ? parsed.data : {};
  const v = await getRevenueView(ctx, { ...q, coverageDays: one(p.coverageDays) || undefined });
  const name = (id: string) => v.accountNames.get(id) ?? "Account";
  const noMoney = (n: number) =>
    `${n} renewal${n === 1 ? "" : "s"} with no contract value on file, not counted`;
  return (
    <div className="space-y-section">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Revenue</h1>
        <p className="text-muted-foreground text-sm">
          Every figure comes from revenue events, contracts and subscriptions on record; each can be
          traced to its records. Currencies are never converted.
        </p>
      </div>

      <DataListCard className="p-5 space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/60 pb-3">
          <h2 id="wf-h" className="text-base font-semibold">
            ARR waterfall, {v.waterfall.from} to {v.waterfall.to}
          </h2>
          <form method="get" className="flex flex-wrap items-center gap-2.5 text-xs">
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground font-medium">From</span>
              <Input type="date" name="from" defaultValue={v.waterfall.from} className="h-8 w-auto text-xs" />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground font-medium">To</span>
              <Input type="date" name="to" defaultValue={v.waterfall.to} className="h-8 w-auto text-xs" />
            </label>
            <Button type="submit" variant="outline" size="sm" className="h-8 text-xs">
              Show
            </Button>
          </form>
        </div>
        <div className="flex flex-wrap gap-8 pt-1">
          <Waterfall w={v.waterfall.base} />
          {v.waterfall.otherCurrencies.map((w) => (
            <Waterfall key={w.currency} w={w} />
          ))}
        </div>
      </DataListCard>

      <DataListCard className="p-5 space-y-3">
        <h2 id="risk-h" className="text-base font-semibold">
          Money at risk ({v.baseCurrency})
        </h2>
        <p className="text-muted-foreground text-xs">
          Open renewals where the account is At Risk on health or renewal confidence is Low.
        </p>
        <div className="space-y-4 pt-1">
          {v.atRisk.map((r) => (
            <div key={r.windowDays} data-testid={`at-risk-${r.windowDays}`} className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">
                Next {r.windowDays} days: <span className="tabular-nums font-semibold">{m(r.arrMinor, r.baseCurrency)}</span> across {r.items.length}{" "}
                renewal
                {r.items.length === 1 ? "" : "s"}
              </p>
              <ul className="text-sm space-y-1 pl-1">
                {r.items.map((i) => (
                  <li key={i.renewalId} className="text-xs text-muted-foreground">
                    <Link
                      href={`/accounts/${i.accountId}/renewal` as Route}
                      className="text-primary font-medium underline underline-offset-2 hover:text-primary/80"
                    >
                      {name(i.accountId)}
                    </Link>
                    :{" "}
                    {i.reasons
                      .map((x) =>
                        x === "ACCOUNT_AT_RISK" ? "account At Risk" : "Low renewal confidence",
                      )
                      .join(", ")}
                  </li>
                ))}
              </ul>
              {r.noArrIds.length ? <p className="text-xs text-muted-foreground">{noMoney(r.noArrIds.length)}.</p> : null}
              {r.otherCurrencies.map((o) => (
                <p key={o.currency} className="text-xs text-muted-foreground">
                  Also {m(o.arrMinor, o.currency)} in {o.currency}, listed apart.
                </p>
              ))}
            </div>
          ))}
        </div>
      </DataListCard>

      <DataListCard className="p-5 space-y-3">
        <h2 id="bill-h" className="text-base font-semibold">
          Expected billing, next {v.billing.months} months
        </h2>
        <p className="text-muted-foreground text-xs">
          A schedule from each subscription&apos;s current period end, assuming active subscriptions
          continue. It is not a prediction.
        </p>
        {v.billing.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No subscription has a billing date in this window.</p>
        ) : (
          <table className="text-left text-sm max-w-lg">
            <caption className="sr-only">Expected billing by month</caption>
            <tbody className="divide-border/40 divide-y">
              {v.billing.rows.map((r) => (
                <tr key={`${r.month}${r.currency}`} className="hover:bg-muted/30">
                  <th scope="row" className="font-normal py-2 text-muted-foreground text-xs">
                    {monthLabel(r.month)}
                  </th>
                  <td className="tabular-nums font-medium py-2 text-foreground text-sm">{m(r.amountMinor, r.currency)}</td>
                  <td className="text-muted-foreground text-xs py-2 text-right">
                    {r.subscriptionIds.length} subscription
                    {r.subscriptionIds.length === 1 ? "" : "s"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {v.billing.excluded.length ? (
          <p className="text-xs text-muted-foreground">
            {v.billing.excluded.length} subscription{v.billing.excluded.length === 1 ? "" : "s"} not
            scheduled (cancelled, ended, or no period end on file).
          </p>
        ) : null}
      </DataListCard>

      <DataListCard className="p-5 space-y-3">
        <h2 id="cov-h" className="text-base font-semibold">
          Coverage
        </h2>
        <p className="text-sm font-medium text-foreground" data-testid="coverage">
          {v.coverage.covered} of {v.coverage.total} accounts had contact in the last{" "}
          {v.coverage.days} days.
        </p>
        <ul className="text-sm space-y-1">
          {v.coverage.untouched.map((a) => (
            <li key={a.id} className="text-xs text-muted-foreground">
              <Link
                href={`/accounts/${a.id}` as Route}
                className="text-primary font-medium underline underline-offset-2 hover:text-primary/80"
              >
                {a.name}
              </Link>
              : no contact for {a.daysSince} days
            </li>
          ))}
        </ul>
        {v.coverage.noContactRecorded.length ? (
          <p className="text-xs text-muted-foreground">
            No contact recorded at all for:{" "}
            {v.coverage.noContactRecorded.map((a) => a.name).join(", ")}.
          </p>
        ) : null}
      </DataListCard>

      <section aria-labelledby="load-h" className="space-y-3">
        <h2 id="load-h" className="text-base font-semibold">
          Team load
        </h2>
        <DataListCard>
          <div className="overflow-x-auto focus-visible:outline-hidden" tabIndex={0} role="region" aria-label="Team load">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Accounts, ARR and open tasks per owner</caption>
              <thead>
                <tr className="border-border bg-muted/60 text-muted-foreground border-b text-[11px] font-semibold tracking-wider uppercase sticky top-0 z-10 backdrop-blur-sm">
                  <th scope="col" className="px-4 py-3">Owner</th>
                  <th scope="col" className="px-4 py-3">Accounts</th>
                  <th scope="col" className="px-4 py-3">ARR ({v.baseCurrency})</th>
                  <th scope="col" className="px-4 py-3">Open tasks</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {v.load.map((r) => {
                  const ownerName = r.ownerMembershipId
                    ? (v.members.get(r.ownerMembershipId) ?? "Former member")
                    : "No owner";
                  return (
                    <tr key={r.ownerMembershipId ?? "none"} className="hover:bg-muted/40 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <DataListAvatar name={ownerName} size="sm" className="shrink-0" />
                          <span className="font-medium text-foreground">{ownerName}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs">{r.accounts}</td>
                      <td className="px-4 py-3 text-xs">
                        <span className="tabular-nums font-semibold text-foreground text-sm">
                          {m(r.arrMinor, v.baseCurrency)}
                        </span>
                        {r.accountsWithoutArr ? (
                          <span className="text-muted-foreground block text-xs">
                            {r.accountsWithoutArr} with no ARR on file
                          </span>
                        ) : null}
                        {r.otherCurrencies.map((o) => (
                          <span key={o.currency} className="text-muted-foreground block text-xs">
                            also {m(o.arrMinor, o.currency)}
                          </span>
                        ))}
                      </td>
                      <td className="px-4 py-3 text-xs">{r.openTasks}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </DataListCard>
      </section>
    </div>
  );
}
