import type { Metadata } from "next";
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
      <div className="space-y-2" data-testid="no-contract">
        <h2 className="text-base font-semibold">No contract on file</h2>
        <p className="text-muted-foreground text-sm">
          There is no contract recorded for this account, so there is no contract value, renewal
          date or notice period to show. Nothing is estimated in its place.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-base font-semibold">Current contract</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!current ? (
            <p className="text-muted-foreground text-sm">
              No contract is in force today. Past contracts are listed below.
            </p>
          ) : (
            <dl
              className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm"
              data-testid="current-contract"
            >
              <dt className="text-muted-foreground">Annual value</dt>
              <dd>{money(current.valueMinor, current.currency)}</dd>
              <dt className="text-muted-foreground">Seats bought</dt>
              <dd>{current.seatsPurchased ?? "Not on file"}</dd>
              <dt className="text-muted-foreground">Start</dt>
              <dd>{formatCalendarDate(current.startDate)}</dd>
              <dt className="text-muted-foreground">Renewal date</dt>
              <dd>
                {current.renewalDate
                  ? formatCalendarDate(current.renewalDate)
                  : "No renewal date on file"}
              </dd>
              <dt className="text-muted-foreground">Notice period</dt>
              <dd>
                {current.noticePeriodDays !== null
                  ? `${current.noticePeriodDays} days`
                  : "Not on file"}
              </dd>
              <dt className="text-muted-foreground">Auto-renews</dt>
              <dd>
                {current.autoRenew === null ? "Not on file" : current.autoRenew ? "Yes" : "No"}
              </dd>
              <dt className="text-muted-foreground">Terms</dt>
              <dd>
                {billing.moneyVisible ? (
                  (current.terms ?? "Not on file")
                ) : (
                  <span className="text-muted-foreground">{RESTRICTED}</span>
                )}
              </dd>
              {billing.moneyVisible && current.pricingNotes ? (
                <>
                  <dt className="text-muted-foreground">Pricing notes</dt>
                  <dd>{current.pricingNotes}</dd>
                </>
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
        <section aria-labelledby="documents" className="space-y-2">
          <h2 id="documents" className="text-base font-semibold">
            Contract documents
          </h2>
          {documents.length === 0 ? (
            <p className="text-muted-foreground text-sm">No signed contract document on file.</p>
          ) : (
            <ul className="divide-border border-border divide-y rounded-md border text-sm">
              {documents.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap justify-between gap-2 p-3"
                  data-testid="contract-document"
                >
                  <span>
                    {d.filename} · {Math.max(1, Math.round(d.sizeBytes / 1024))} KB ·{" "}
                    {formatDate(d.createdAt, tz)}
                  </span>
                  {d.scanStatus === "CLEAN" ? (
                    <a
                      href={`/api/files/${d.id}/download`}
                      className="underline"
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

      <section aria-labelledby="history" className="space-y-2">
        <h2 id="history" className="text-base font-semibold">
          Contract history
        </h2>
        <ul className="divide-border border-border divide-y rounded-md border text-sm">
          {billing.contracts.map((c) => (
            <li key={c.id} className="flex flex-wrap justify-between gap-2 p-3">
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

      <section aria-labelledby="revenue" className="space-y-2">
        <h2 id="revenue" className="text-base font-semibold">
          ARR movements
        </h2>
        {billing.revenueEvents.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No ARR movements derived from the contracts on file.
          </p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-md border text-sm">
            {billing.revenueEvents.map((e) => (
              <li key={e.id} className="flex justify-between gap-2 p-3">
                <span>
                  {EVENT_LABELS[e.type]} · {formatCalendarDate(e.effectiveDate)}
                </span>
                <span className="tabular-nums">{money(e.deltaArrMinor, e.currency)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="invoices" className="space-y-2">
        <h2 id="invoices" className="text-base font-semibold">
          Invoices
        </h2>
        {billing.invoices.length === 0 ? (
          <p className="text-muted-foreground text-sm">No invoices on file.</p>
        ) : (
          <div
            className="border-border overflow-x-auto rounded-md border"
            role="region"
            aria-label="Invoices"
            tabIndex={0}
          >
            <table className="w-full min-w-[36rem] text-sm">
              <caption className="sr-only">Invoices, newest first</caption>
              <thead className="bg-muted text-muted-foreground text-left text-xs">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Invoice
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Issued
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Due
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {billing.invoices.map((i) => (
                  <tr key={i.id} className="border-border border-t">
                    <td className="px-3 py-2">{i.number}</td>
                    <td className="px-3 py-2">{formatCalendarDate(i.issuedAt)}</td>
                    <td className="px-3 py-2">{formatCalendarDate(i.dueAt)}</td>
                    <td
                      className={
                        i.status === "FAILED" || i.status === "UNCOLLECTIBLE"
                          ? "px-3 py-2 text-[var(--risk-at-risk)]"
                          : "px-3 py-2"
                      }
                    >
                      {INVOICE_STATUS[i.status]}
                      {i.failureCount > 0
                        ? ` (${i.failureCount} failed attempt${i.failureCount > 1 ? "s" : ""})`
                        : ""}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {money(i.amountMinor, i.currency)}
                    </td>
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
