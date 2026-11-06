import type { Metadata, Route } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/app/empty-state";
import { CategoryControl, CategoryState, Reasons, BAND_WORDS } from "@/components/renewals/reasons";
import { formatCalendarDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { CATEGORY_WORDS, getAccountRenewals } from "@/modules/renewals/service";
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
    <div className="space-y-section">
      {ok ? (
        <p
          role="status"
          className="bg-success-soft text-success-soft-foreground rounded-md px-3 py-2 text-sm"
        >
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
      {data.open.length === 0 ? (
        <EmptyState>
          No open renewal on record. A renewal appears once a contract has a renewal date; add the
          date on the Billing tab.
        </EmptyState>
      ) : (
        data.open.map((r) => (
          <section
            key={r.id}
            className="surface space-y-3 p-5"
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
              <Link
                href={`/renewals/${r.id}/brief` as Route}
                className="text-primary underline underline-offset-2"
              >
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
        <section
          aria-labelledby="past-h"
          className="surface space-y-2 p-5"
          data-testid="past-renewals"
        >
          <h2 id="past-h" className="text-base font-semibold">
            Earlier renewals
          </h2>
          <ul className="space-y-1 text-sm">
            {data.past.map((p) => (
              <li key={p.id}>
                {formatCalendarDate(p.renewalDate)}: {p.stage === "RENEWED" ? "Renewed" : "Churned"}
                {p.outcome ? (
                  <span className="text-muted-foreground block text-xs">
                    Recorded {formatCalendarDate(p.outcome.occurredOn)}
                    {p.outcome.detectedVia === "CONTRACT_RECORDS" ? " from contract records" : ""}.
                    The forecast on {formatCalendarDate(p.outcome.forecast.asOf)} said{" "}
                    {p.outcome.forecast.confidence}% ({BAND_WORDS[p.outcome.forecast.band]}{" "}
                    confidence)
                    {p.outcome.forecast.category
                      ? `, and a person had it as ${CATEGORY_WORDS[p.outcome.forecast.category]}`
                      : ""}
                    .{" "}
                    {!p.outcome.moneyVisible
                      ? "Contract value: Restricted."
                      : p.outcome.outcomeArrMinor != null && p.outcome.currency
                        ? `Value after: ${formatMoney({ minor: p.outcome.outcomeArrMinor, currency: p.outcome.currency })}.`
                        : "No contract value on file."}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
