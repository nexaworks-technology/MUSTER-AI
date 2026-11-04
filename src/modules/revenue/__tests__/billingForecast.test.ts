import { describe, expect, it } from "vitest";
import { addMonths, billingForecast, type ForecastSubscription } from "../billingForecast";

const sub = (
  id: string,
  interval: "MONTH" | "YEAR",
  amount: number,
  end: string | null,
  status: ForecastSubscription["status"] = "ACTIVE",
  currency = "USD",
): ForecastSubscription => ({
  id,
  accountId: "a",
  interval,
  amountMinor: BigInt(amount),
  currency,
  status,
  currentPeriodEnd: end ? new Date(`${end}T00:00:00Z`) : null,
});

describe("billingForecast", () => {
  it("clamps month ends", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
  });
  const f = billingForecast(
    [
      sub("m", "MONTH", 1_000, "2026-11-15"),
      sub("y", "YEAR", 12_000, "2027-01-20"),
      sub("c", "MONTH", 500, "2026-11-20", "CANCELLED"),
      sub("e", "YEAR", 9_999, "2026-12-01", "ENDED"),
      sub("n", "MONTH", 700, null),
      sub("eur", "MONTH", 200, "2026-12-05", "PAST_DUE", "EUR"),
    ],
    "2026-11-04",
    4,
  );
  it("bills active and past-due subscriptions at each interval, per month and currency, with ids", () => {
    expect(f.rows).toEqual([
      { month: "2026-11", currency: "USD", amountMinor: 1_000n, subscriptionIds: ["m"] },
      { month: "2026-12", currency: "EUR", amountMinor: 200n, subscriptionIds: ["eur"] },
      { month: "2026-12", currency: "USD", amountMinor: 1_000n, subscriptionIds: ["m"] },
      { month: "2027-01", currency: "EUR", amountMinor: 200n, subscriptionIds: ["eur"] },
      { month: "2027-01", currency: "USD", amountMinor: 13_000n, subscriptionIds: ["m", "y"] },
      { month: "2027-02", currency: "EUR", amountMinor: 200n, subscriptionIds: ["eur"] },
      { month: "2027-02", currency: "USD", amountMinor: 1_000n, subscriptionIds: ["m"] },
    ]);
  });
  it("lists cancelled, ended and no-period-end subscriptions as excluded, never guessing", () => {
    expect(f.excluded).toEqual([
      { id: "c", reason: "CANCELLED" },
      { id: "e", reason: "ENDED" },
      { id: "n", reason: "NO_PERIOD_END" },
    ]);
  });
});
