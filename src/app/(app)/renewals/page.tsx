import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { NativeSelect } from "@/components/app/native-select";
import { DataListAvatar, DataListCard } from "@/components/app/data-list";
import { StatusPill } from "@/components/app/status-pill";
import { CategoryControl, CategoryState, Reasons, BAND_WORDS } from "@/components/renewals/reasons";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatCalendarDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { listRenewals, CATEGORY_WORDS, renewalTiming, type Forecast } from "@/modules/renewals/service";
import { listMembers } from "@/modules/settings/service";

export const metadata: Metadata = { title: "Renewals" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const WINDOWS = [30, 60, 90, 180, 365];

const money = (minor: bigint, currency: string) => formatMoney({ minor, currency });

function ForecastSection({ f }: { f: Forecast }) {
  const rows = [
    ...(["HIGH", "MEDIUM", "LOW"] as const).map((b) => ({
      label: `${BAND_WORDS[b]} confidence`,
      v: f.byBand[b],
    })),
  ];
  const cats = (["COMMIT", "BEST_CASE", "AT_RISK", "UNSET"] as const).map((c) => ({
    label: c === "UNSET" ? "Not categorised" : CATEGORY_WORDS[c],
    v: f.byCategory[c],
  }));
  const table = (title: string, items: typeof rows) => (
    <table className="text-left text-sm">
      <caption className="text-left font-medium">{title}</caption>
      <tbody>
        {items.map((r) => (
          <tr key={r.label}>
            <th scope="row" className="font-normal pr-4">
              {r.label}
            </th>
            <td className="tabular-nums font-medium pr-4">{money(r.v.arrMinor, f.baseCurrency)}</td>
            <td className="text-muted-foreground text-xs">
              {r.v.renewalIds.length} renewal{r.v.renewalIds.length === 1 ? "" : "s"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <DataListCard className="p-5 space-y-3" data-testid="forecast">
      <h2 id="forecast-h" className="text-lg font-semibold">
        Forecast for this window ({f.baseCurrency})
      </h2>
      <div className="flex flex-wrap gap-8">
        {table("By computed confidence", rows)}
        {table("By forecast category (set by people)", cats)}
      </div>
      {f.omittedIds.length ? (
        <p className="text-muted-foreground text-xs">
          {f.omittedIds.length} renewal{f.omittedIds.length === 1 ? "" : "s"} marked Omitted by a
          person are left out of both tables.
        </p>
      ) : null}
      {f.otherCurrencies.map((o) => (
        <p key={o.currency} className="text-xs">
          Also {money(o.arrMinor, o.currency)} in {o.currency} across {o.renewalIds.length} renewal
          {o.renewalIds.length === 1 ? "" : "s"}, listed apart and not converted.
        </p>
      ))}
      {f.noArrIds.length ? (
        <p className="text-xs">
          {f.noArrIds.length} renewal{f.noArrIds.length === 1 ? "" : "s"} with no contract value on
          file are not counted.
        </p>
      ) : null}
    </DataListCard>
  );
}

/**
 * Renewals (spec §6N): open renewals in the member's book, lowest confidence first. Each row
 * opens to the reasons behind the figure with links to the records; the human forecast category
 * sits beside the computed band and a difference is flagged.
 */
export default async function RenewalsPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, "accounts:view")) notFound();
  const params = await searchParams;
  const days = Number(one(params.days) ?? 90) || 90;
  const band = one(params.band);
  const owner = one(params.owner);
  const page = Number(one(params.page) ?? 1) || 1;
  const list = await listRenewals(ctx, {
    days,
    band: band || undefined,
    owner: owner || undefined,
    page,
  });
  const members = can(ctx, "workspace:manageUsers") ? await listMembers(ctx) : [];
  const ok = one(params.ok);
  const error = one(params.error);
  const href = (p: number) => {
    const q = new URLSearchParams({
      days: String(days),
      ...(band ? { band } : {}),
      ...(owner ? { owner } : {}),
      page: String(p),
    });
    return `/renewals?${q.toString()}` as Route;
  };

  return (
    <div className="space-y-section">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Renewals</h1>
        <p className="text-muted-foreground text-sm">
          Open renewals renewing within {list.days} days, and any still open after their date (overdue), lowest confidence first. Confidence is
          worked out from records by fixed rules; open a row to see each reason and its sources.
        </p>
      </div>
      {ok ? (
        <p role="status" className="bg-muted text-foreground rounded-md px-3 py-2 text-sm">
          {ok}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="bg-danger-soft text-danger-soft-foreground rounded-md px-3 py-2 text-sm"
        >
          {error}
        </p>
      ) : null}
      <DataListCard className="p-3">
        <form method="get" className="flex flex-wrap items-center gap-3 text-xs sm:text-sm">
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground font-medium">Renewing within</span>
            <NativeSelect name="days" defaultValue={String(list.days)} className="h-8 text-xs">
              {WINDOWS.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground font-medium">Confidence</span>
            <NativeSelect name="band" defaultValue={band ?? ""} className="h-8 text-xs">
              <option value="">All</option>
              {Object.entries(BAND_WORDS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </NativeSelect>
          </label>
          {members.length ? (
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground font-medium">Owner</span>
              <NativeSelect name="owner" defaultValue={owner ?? ""} className="h-8 text-xs">
                <option value="">Everyone</option>
                {members
                  .filter((m) => m.status === "ACTIVE")
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.user.name ?? m.user.email}
                    </option>
                  ))}
              </NativeSelect>
            </label>
          ) : null}
          <Button type="submit" variant="outline" size="sm" className="h-8">
            Filter
          </Button>
        </form>
      </DataListCard>

      {list.forecast ? <ForecastSection f={list.forecast} /> : null}

      {list.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No open renewals in this window{band || owner ? " with these filters" : ""}.
        </p>
      ) : (
        <DataListCard>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Open renewals, lowest confidence first</caption>
              <thead>
                <tr className="border-border bg-muted/60 text-muted-foreground border-b text-[11px] font-semibold tracking-wider uppercase sticky top-0 z-10 backdrop-blur-sm">
                  <th scope="col" className="px-4 py-3">Account</th>
                  <th scope="col" className="px-4 py-3">Renews</th>
                  <th scope="col" className="px-4 py-3">Confidence</th>
                  <th scope="col" className="px-4 py-3">ARR</th>
                  <th scope="col" className="px-4 py-3">Forecast category</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {list.rows.map((r) => {
                  const pillVariant = r.band === "HIGH" ? "healthy" : r.band === "MEDIUM" ? "watch" : "atRisk";
                  return (
                    <tr key={r.id} className="align-top hover:bg-muted/40 transition-colors" data-testid={`renewal-row-${r.account.name}`}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <DataListAvatar name={r.account.name} size="sm" className="shrink-0" />
                          <div>
                            <Link
                              href={`/accounts/${r.account.id}/renewal` as Route}
                              className="font-medium text-foreground hover:underline"
                            >
                              {r.account.name}
                            </Link>
                            <Link
                              href={`/renewals/${r.id}/brief` as Route}
                              className="text-muted-foreground block text-xs underline"
                            >
                              Renewal brief
                            </Link>
                            <span className="text-muted-foreground block text-xs">
                              {r.account.owner ?? "No owner"}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-foreground font-medium">{formatCalendarDate(r.renewalDate)}</span>
                        <span
                          className={`block text-xs ${r.overdue ? "text-destructive font-medium" : "text-muted-foreground"}`}
                          data-testid="renewal-timing"
                        >
                          {r.overdue ? "Overdue: still open, " : ""}
                          {renewalTiming(r.daysToRenewal)}
                          {r.noticeDeadline
                            ? `, notice by ${formatCalendarDate(r.noticeDeadline)}`
                            : ", no notice period on file"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill variant={pillVariant} size="sm">
                          <span data-testid="confidence">{r.confidence}%</span> {BAND_WORDS[r.band]}
                        </StatusPill>
                        <details className="mt-1.5">
                          <summary className="text-primary cursor-pointer text-xs underline underline-offset-2">
                            Why {r.confidence}%
                          </summary>
                          <div className="mt-2">
                            <Reasons accountId={r.account.id} factors={r.reasons} />
                          </div>
                        </details>
                      </td>
                      <td className="px-4 py-3 tabular-nums font-medium text-foreground">
                        {!r.moneyVisible
                          ? "Restricted"
                          : r.arrMinor != null && r.currency
                            ? money(r.arrMinor, r.currency)
                            : "No contract value on file"}
                      </td>
                      <td className="px-4 py-3">
                        <CategoryState row={r} />
                        {r.canCategorise ? (
                          <details className="mt-1.5">
                            <summary className="text-primary cursor-pointer text-xs underline underline-offset-2">
                              Change
                            </summary>
                            <div className="mt-2">
                              <CategoryControl row={r} returnTo="/renewals" />
                            </div>
                          </details>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </DataListCard>
      )}
      {list.pages > 1 ? (
        <nav aria-label="Pages" className="flex items-center justify-between text-xs sm:text-sm font-medium">
          <div>
            {list.page > 1 ? (
              <Link href={href(list.page - 1)} className="inline-flex items-center gap-1.5 text-primary hover:underline">
                <ArrowLeft className="size-3.5" />
                Previous
              </Link>
            ) : null}
          </div>
          <span className="text-muted-foreground text-xs">
            Page {list.page} of {list.pages}
          </span>
          <div>
            {list.page < list.pages ? (
              <Link href={href(list.page + 1)} className="inline-flex items-center gap-1.5 text-primary hover:underline">
                Next
                <ArrowRight className="size-3.5" />
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
