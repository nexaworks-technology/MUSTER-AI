import type { Metadata } from "next";
import { EmptyState } from "@/components/app/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatArr, formatCalendarDate, formatDate, RESTRICTED } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { getBilling } from "@/modules/billing/service";
import { listContractDocuments } from "@/modules/files/service";
import { ContractDocumentUpload } from "@/components/app/contract-document-upload";
import { ALLOWED_BY_PURPOSE } from "@/config/uploads";
import { loadAccount } from "../data";

export const metadata: Metadata = { title: "Contracts & billing" };

const INVOICE_STATUS = {
  OPEN: "Open",
  PAID: "Paid",
  FAILED: "Payment failed",
  VOID: "Void",
  UNCOLLECTIBLE: "Uncollectible",
} as const;
const EVENT_LABELS = {
  NEW: "New",
  EXPANSION: "Expansion",
  CONTRACTION: "Contraction",
  CHURN: "Churn",
  REACTIVATION: "Reactivation",
} as const;

export default async function BillingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx, account } = await loadAccount(id);
  const tz = ctx.workspace.timezone;
  const [billing, documents] = await Promise.all([
    getBilling(ctx, account.id),
    listContractDocuments(ctx, account.id),
  ]);
  const accept = ALLOWED_BY_PURPOSE.CONTRACT_DOCUMENT.map((e) => `.${e}`).join(",");
  const money = (minor: bigint | undefined | null, currency: string) =>
    !billing.moneyVisible ? (
      <span className="text-muted-foreground">{RESTRICTED}</span>
    ) : minor === null || minor === undefined ? (
      "Not on file"
    ) : (
      formatMoney({ minor, currency })
    );
  const current = billing.contracts.find((c) => c.id === billing.currentContractId);

  if (billing.contracts.length === 0) {
    return (
      <div className="surface space-y-2 p-5" data-testid="no-contract">
        <h2 className="text-base font-semibold">No contract on file</h2>
        <p className="text-muted-foreground text-sm">
          There is no contract recorded for this account, so there is no contract value, renewal
          date or notice period to show. Nothing is estimated in its place.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-section">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Current contract</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!current ? (
            <EmptyState>No contract is in force today. Past contracts are listed below.</EmptyState>
          ) : (
            <dl className="divide-border divide-y text-sm" data-testid="current-contract">
              <div className="flex gap-4 py-2 first:pt-0 last:pb-0">
                <dt className="text-muted-foreground w-40 shrink-0">Annual value</dt>
                <dd className="min-w-0">{money(current.valueMinor, current.currency)}</dd>
              </div>
              <div className="flex gap-4 py-2 first:pt-0 last:pb-0">
                <dt className="text-muted-foreground w-40 shrink-0">Seats bought</dt>
                <dd className="min-w-0">{current.seatsPurchased ?? "Not on file"}</dd>
              </div>
              <div className="flex gap-4 py-2 first:pt-0 last:pb-0">
                <dt className="text-muted-foreground w-40 shrink-0">Start</dt>
                <dd className="min-w-0">{formatCalendarDate(current.startDate)}</dd>
              </div>
              <div className="flex gap-4 py-2 first:pt-0 last:pb-0">
                <dt className="text-muted-foreground w-40 shrink-0">Renewal date</dt>
                <dd className="min-w-0">
                  {current.renewalDate
                    ? formatCalendarDate(current.renewalDate)
                    : "No renewal date on file"}
                </dd>
              </div>
              <div className="flex gap-4 py-2 first:pt-0 last:pb-0">
                <dt className="text-muted-foreground w-40 shrink-0">Notice period</dt>
                <dd className="min-w-0">
                  {current.noticePeriodDays !== null
                    ? `${current.noticePeriodDays} days`
                    : "Not on file"}
                </dd>
              </div>
              <div className="flex gap-4 py-2 first:pt-0 last:pb-0">
                <dt className="text-muted-foreground w-40 shrink-0">Auto-renews</dt>
                <dd className="min-w-0">
                  {current.autoRenew === null ? "Not on file" : current.autoRenew ? "Yes" : "No"}
                </dd>
              </div>
              <div className="flex gap-4 py-2 first:pt-0 last:pb-0">
                <dt className="text-muted-foreground w-40 shrink-0">Terms</dt>
                <dd className="min-w-0">
                  {billing.moneyVisible ? (
                    (current.terms ?? "Not on file")
                  ) : (
                    <span className="text-muted-foreground">{RESTRICTED}</span>
                  )}
                </dd>
              </div>
              {billing.moneyVisible && current.pricingNotes ? (
                <div className="flex gap-4 py-2 first:pt-0 last:pb-0">
                  <dt className="text-muted-foreground w-40 shrink-0">Pricing notes</dt>
                  <dd className="min-w-0">{current.pricingNotes}</dd>
                </div>
              ) : null}
            </dl>
          )}
          {billing.moneyVisible && "arrMinor" in billing.account ? (
            <p className="text-muted-foreground mt-3 text-sm">
              ARR:{" "}
              {formatArr(
                billing.account.arrMinor !== null
                  ? {
                      minor: billing.account.arrMinor,
                      currency: billing.account.arrCurrency ?? "USD",
                    }
                  : null,
              )}
            </p>
          ) : null}
        </CardContent>
      </Card>
      {billing.moneyVisible ? (
        <section aria-labelledby="documents" className="space-y-3">
          <h2 id="documents" className="text-base font-semibold">
            Contract documents
          </h2>
          {documents.length === 0 ? (
            <EmptyState>No signed contract document on file.</EmptyState>
          ) : (
            <ul className="surface divide-border divide-y overflow-hidden text-sm">
              {documents.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap justify-between gap-2 p-4"
                  data-testid="contract-document"
                >
                  <span>
                    {d.filename} · {Math.max(1, Math.round(d.sizeBytes / 1024))} KB ·{" "}
                    {formatDate(d.createdAt, tz)}
                  </span>
                  {d.scanStatus === "CLEAN" ? (
                    <a
                      href={`/api/files/${d.id}/download`}
                      className="text-primary underline underline-offset-2"
                      aria-label={`Download ${d.filename}`}
                    >
                      Download
                    </a>
                  ) : (
                    <span className="text-muted-foreground">Waiting for security scan</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {account.canEdit && current ? (
            <ContractDocumentUpload
              accountId={account.id}
              contractId={current.id}
              accept={accept}
            />
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="history" className="space-y-3">
        <h2 id="history" className="text-base font-semibold">
          Contract history
        </h2>
        <ul className="surface divide-border divide-y overflow-hidden text-sm">
          {billing.contracts.map((c) => (
            <li
              key={c.id}
              id={`contract-${c.id}`}
              className="target:bg-muted flex scroll-mt-4 flex-wrap justify-between gap-2 p-4"
            >
              <span>
                {formatCalendarDate(c.startDate)} –{" "}
                {c.endDate ? formatCalendarDate(c.endDate) : "no end date"} ·{" "}
                {c.status.toLowerCase()}
              </span>
              <span className="tabular-nums">{money(c.valueMinor, c.currency)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="revenue" className="space-y-3">
        <h2 id="revenue" className="text-base font-semibold">
          ARR movements
        </h2>
        {billing.revenueEvents.length === 0 ? (
          <EmptyState>No ARR movements derived from the contracts on file.</EmptyState>
        ) : (
          <ul className="surface divide-border divide-y overflow-hidden text-sm">
            {billing.revenueEvents.map((e) => (
              <li
                key={e.id}
                id={`revenue-${e.id}`}
                className="target:bg-muted flex scroll-mt-4 justify-between gap-2 p-4"
              >
                <span>
                  {EVENT_LABELS[e.type]} · {formatCalendarDate(e.effectiveDate)}
                </span>
                <span className="tabular-nums">{money(e.deltaArrMinor, e.currency)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="invoices" className="space-y-3">
        <h2 id="invoices" className="text-base font-semibold">
          Invoices
        </h2>
        {billing.invoices.length === 0 ? (
          <EmptyState>No invoices on file.</EmptyState>
        ) : (
          <div className="surface overflow-x-auto" role="region" aria-label="Invoices" tabIndex={0}>
            <table className="w-full min-w-144 text-sm">
              <caption className="sr-only">Invoices, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Issued</th>
                  <th scope="col">Due</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="text-right">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {billing.invoices.map((i) => (
                  <tr key={i.id} id={`invoice-${i.id}`} className="target:bg-muted scroll-mt-4">
                    <td>{i.number}</td>
                    <td>{formatCalendarDate(i.issuedAt)}</td>
                    <td>{formatCalendarDate(i.dueAt)}</td>
                    <td
                      className={
                        i.status === "FAILED" || i.status === "UNCOLLECTIBLE"
                          ? "text-risk-at-risk font-medium"
                          : undefined
                      }
                    >
                      {INVOICE_STATUS[i.status]}
                      {i.failureCount > 0
                        ? ` (${i.failureCount} failed attempt${i.failureCount > 1 ? "s" : ""})`
                        : ""}
                    </td>
                    <td className="text-right">{money(i.amountMinor, i.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
