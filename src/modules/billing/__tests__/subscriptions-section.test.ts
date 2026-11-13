import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SubscriptionsSection,
  type SubscriptionRow,
} from "@/app/(app)/accounts/[id]/billing/subscriptions-section";

/**
 * CONNECTOR-LIVE.md, B1 finding 2: Account 360 › Billing shows the account's subscriptions (plan,
 * amount, quantity, status, renewal date, source) whether or not a contract is on file. Money
 * follows the same rule as the rest of the tab: hidden, not zeroed, without revenue access.
 */
const ALPHA: SubscriptionRow = {
  id: "sub_alpha",
  plan: "PROOF Plan",
  interval: "MONTH",
  amountMinor: 36_000n,
  currency: "USD",
  quantity: 3,
  status: "ACTIVE",
  currentPeriodEnd: new Date("2026-12-01T00:00:00Z"),
  sourceLabel: "Stripe",
};

const html = (rows: SubscriptionRow[], moneyVisible = true) =>
  renderToStaticMarkup(createElement(SubscriptionsSection, { subscriptions: rows, moneyVisible }));

/** The text of each body row's cells. */
function cells(markup: string): string[][] {
  const body = markup.slice(markup.indexOf("<tbody>"), markup.indexOf("</tbody>"));
  return [...body.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((r) =>
    [...r[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1]!.replace(/<[^>]+>/g, "")),
  );
}

describe("Billing tab subscriptions", () => {
  it("shows plan, amount, quantity, status, renewal date and source", () => {
    const out = html([
      ALPHA,
      {
        ...ALPHA,
        id: "sub_beta",
        amountMinor: 120_000n,
        quantity: 10,
        interval: "YEAR",
        status: "PAST_DUE",
        currentPeriodEnd: null,
        sourceLabel: "a CSV import",
      },
    ]);
    expect(out).toContain('id="subscriptions"');
    expect(cells(out)).toEqual([
      ["PROOF Plan", "$360.00 / month", "3", "Active", "Dec 1, 2026", "Stripe"],
      [
        "PROOF Plan",
        "$1,200.00 / year",
        "10",
        "Past due",
        "No renewal date on file",
        "a CSV import",
      ],
    ]);
    expect(out).toContain('id="subscription-sub_alpha"');
  });

  it("hides amounts without revenue access, and never shows a zero instead", () => {
    const { amountMinor: _a, ...noMoney } = ALPHA;
    const out = html([noMoney], false);
    expect(cells(out)[0]![1]).toBe("Restricted");
    expect(out).not.toContain("$");
  });

  it("says so when there are no subscriptions", () => {
    const out = html([]);
    expect(out).toContain("No subscriptions on file.");
    expect(out).not.toContain("<table");
  });
});
