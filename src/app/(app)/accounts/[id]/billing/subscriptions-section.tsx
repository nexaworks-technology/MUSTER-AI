import { EmptyState } from "@/components/app/empty-state";
import { formatCalendarDate, RESTRICTED } from "@/lib/format";
import { formatMoney } from "@/lib/money";

/**
 * Account 360 › Billing: the account's subscriptions, shown whether or not a contract is on file
 * (CONNECTOR-LIVE.md, B1 finding 2). Each row names where it came from. Without revenue access the
 * amount key is absent (redactFinancials) and the cell says Restricted, never a zero.
 */
export interface SubscriptionRow {
  id: string;
  plan: string;
  interval: "MONTH" | "YEAR";
  amountMinor?: bigint;
  currency: string;
  quantity: number;
  status: "ACTIVE" | "PAST_DUE" | "CANCELLED" | "ENDED";
  currentPeriodEnd: Date | null;
  /** Where the row came from, in words ("Stripe", "a CSV import"). */
  sourceLabel: string;
}

const STATUS: Record<SubscriptionRow["status"], string> = {
  ACTIVE: "Active",
  PAST_DUE: "Past due",
  CANCELLED: "Cancelled",
  ENDED: "Ended",
};
const PER: Record<SubscriptionRow["interval"], string> = { MONTH: "month", YEAR: "year" };

export function SubscriptionsSection({
  subscriptions,
  moneyVisible,
}: {
  subscriptions: SubscriptionRow[];
  moneyVisible: boolean;
}) {
  return (
    <section aria-labelledby="subscriptions" className="space-y-3">
      <h2 id="subscriptions" className="text-base font-semibold">
        Subscriptions
      </h2>
      {subscriptions.length === 0 ? (
        <EmptyState>No subscriptions on file.</EmptyState>
      ) : (
        <div
          className="surface overflow-x-auto"
          role="region"
          aria-label="Subscriptions"
          tabIndex={0}
        >
          <table className="w-full min-w-144 text-sm">
            <caption className="sr-only">Subscriptions, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col" className="text-right">
                  Amount
                </th>
                <th scope="col" className="text-right">
                  Quantity
                </th>
                <th scope="col">Status</th>
                <th scope="col">Renewal date</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((s) => (
                <tr key={s.id} id={`subscription-${s.id}`} className="target:bg-muted scroll-mt-4">
                  <td>{s.plan}</td>
                  <td className="text-right tabular-nums">
                    {!moneyVisible || s.amountMinor === undefined ? (
                      <span className="text-muted-foreground">{RESTRICTED}</span>
                    ) : (
                      `${formatMoney({ minor: s.amountMinor, currency: s.currency })} / ${PER[s.interval]}`
                    )}
                  </td>
                  <td className="text-right tabular-nums">{s.quantity}</td>
                  <td
                    className={
                      s.status === "PAST_DUE" ? "text-risk-at-risk font-medium" : undefined
                    }
                  >
                    {STATUS[s.status]}
                  </td>
                  <td>
                    {s.currentPeriodEnd
                      ? formatCalendarDate(s.currentPeriodEnd)
                      : "No renewal date on file"}
                  </td>
                  <td>{s.sourceLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
