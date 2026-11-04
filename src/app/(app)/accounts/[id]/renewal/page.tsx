import type { Metadata, Route } from "next";
import Link from "next/link";
import { CategoryControl, CategoryState, Reasons, BAND_WORDS } from "@/components/renewals/reasons";
import { formatCalendarDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { getAccountRenewals } from "@/modules/renewals/service";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Renewal" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Account 360 › Renewal: the open renewal, its confidence reasons with sources, the category. */
export default async function RenewalTab({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const { ctx } = await loadAccount(id);
  const data = await getAccountRenewals(ctx, id);
  const q = await searchParams;
  const ok = one(q.ok);
  const error = one(q.error);
  const returnTo = `/accounts/${id}/renewal`;
  return (
    <div className="space-y-6">
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
      {data.open.length === 0 ? (
        <p className="text-sm">
          No open renewal on record. A renewal appears once a contract has a renewal date; add the
          date on the Billing tab.
        </p>
      ) : (
        data.open.map((r) => (
          <section
            key={r.id}
            className="space-y-3"
            aria-label={`Renewal on ${formatCalendarDate(r.renewalDate)}`}
          >
            <h2 className="text-lg font-semibold">Renews {formatCalendarDate(r.renewalDate)}</h2>
            <p className="text-sm">
              Confidence <strong data-testid="confidence">{r.confidence}%</strong> (
              {BAND_WORDS[r.band]}), in {r.daysToRenewal} days.{" "}
              {!r.moneyVisible
                ? "Contract value: Restricted."
                : r.arrMinor != null && r.currency
                  ? `Contract value ${formatMoney({ minor: r.arrMinor, currency: r.currency })}.`
                  : "No contract value on file."}
            </p>
            <p className="text-sm">
              <Link href={`/renewals/${r.id}/brief` as Route} className="underline">
                Open the renewal brief
              </Link>
            </p>
            <Reasons accountId={id} factors={r.reasons} />
            <div>
              <h3 className="text-sm font-medium">Forecast category</h3>
              <CategoryState row={r} />
              {r.canCategorise ? (
                <div className="mt-2">
                  <CategoryControl row={r} returnTo={returnTo} />
                </div>
              ) : null}
            </div>
          </section>
        ))
      )}
      {data.past.length ? (
        <section>
          <h2 className="text-sm font-medium">Earlier renewals</h2>
          <ul className="text-sm">
            {data.past.map((p) => (
              <li key={p.id}>
                {formatCalendarDate(p.renewalDate)}: {p.stage === "RENEWED" ? "Renewed" : "Churned"}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
