import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CategoryControl, CategoryState, Reasons, BAND_WORDS } from "@/components/renewals/reasons";
import { can } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext } from "@/lib/auth/session";
import { formatCalendarDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { listRenewals, CATEGORY_WORDS, type Forecast } from "@/modules/renewals/service";
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
            <th scope="row" className="py-1 pr-4 font-normal">
              {r.label}
            </th>
            <td className="py-1 pr-4">{money(r.v.arrMinor, f.baseCurrency)}</td>
            <td className="text-muted-foreground py-1 text-xs">
              {r.v.renewalIds.length} renewal{r.v.renewalIds.length === 1 ? "" : "s"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <section aria-labelledby="forecast-h" className="space-y-2" data-testid="forecast">
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
    </section>
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
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Renewals</h1>
      <p className="text-muted-foreground text-sm">
        Open renewals renewing within {list.days} days, lowest confidence first. Confidence is
        worked out from records by fixed rules; open a row to see each reason and its sources.
      </p>
      {ok ? (
        <p role="status" className="text-sm">
          {ok}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm">
          {error}
        </p>
      ) : null}
      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          Renewing within
          <select
            name="days"
            defaultValue={String(list.days)}
            className="border-input rounded-md border px-2 py-1"
          >
            {WINDOWS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Confidence
          <select
            name="band"
            defaultValue={band ?? ""}
            className="border-input rounded-md border px-2 py-1"
          >
            <option value="">All</option>
            {Object.entries(BAND_WORDS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {members.length ? (
          <label className="flex flex-col gap-1">
            Owner
            <select
              name="owner"
              defaultValue={owner ?? ""}
              className="border-input rounded-md border px-2 py-1"
            >
              <option value="">Everyone</option>
              {members
                .filter((m) => m.status === "ACTIVE")
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.user.name ?? m.user.email}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        <button type="submit" className="border-input rounded-md border px-3 py-1">
          Filter
        </button>
      </form>

      {list.forecast ? <ForecastSection f={list.forecast} /> : null}

      {list.rows.length === 0 ? (
        <p className="text-sm">
          No open renewals in this window{band || owner ? " with these filters" : ""}.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Open renewals, lowest confidence first</caption>
            <thead>
              <tr className="border-border border-b">
                <th scope="col" className="py-2 pr-3">
                  Account
                </th>
                <th scope="col" className="py-2 pr-3">
                  Renews
                </th>
                <th scope="col" className="py-2 pr-3">
                  Confidence
                </th>
                <th scope="col" className="py-2 pr-3">
                  ARR
                </th>
                <th scope="col" className="py-2 pr-3">
                  Forecast category
                </th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-border border-b align-top"
                  data-testid={`renewal-row-${r.account.name}`}
                >
                  <td className="py-2 pr-3">
                    <Link href={`/accounts/${r.account.id}/renewal` as Route} className="underline">
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
                  </td>
                  <td className="py-2 pr-3">
                    {formatCalendarDate(r.renewalDate)}
                    <span className="text-muted-foreground block text-xs">
                      in {r.daysToRenewal} days
                      {r.noticeDeadline
                        ? `, notice by ${formatCalendarDate(r.noticeDeadline)}`
                        : ", no notice period on file"}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    <span data-testid="confidence">{r.confidence}%</span> {BAND_WORDS[r.band]}
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs underline">
                        Why {r.confidence}%
                      </summary>
                      <div className="mt-2">
                        <Reasons accountId={r.account.id} factors={r.reasons} />
                      </div>
                    </details>
                  </td>
                  <td className="py-2 pr-3">
                    {!r.moneyVisible
                      ? "Restricted"
                      : r.arrMinor != null && r.currency
                        ? money(r.arrMinor, r.currency)
                        : "No contract value on file"}
                  </td>
                  <td className="py-2 pr-3">
                    <CategoryState row={r} />
                    {r.canCategorise ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs underline">Change</summary>
                        <div className="mt-2">
                          <CategoryControl row={r} returnTo="/renewals" />
                        </div>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.pages > 1 ? (
        <nav aria-label="Pages" className="flex gap-3 text-sm">
          {list.page > 1 ? <Link href={href(list.page - 1)}>Previous</Link> : null}
          <span>
            Page {list.page} of {list.pages}
          </span>
          {list.page < list.pages ? <Link href={href(list.page + 1)}>Next</Link> : null}
        </nav>
      ) : null}
    </div>
  );
}
