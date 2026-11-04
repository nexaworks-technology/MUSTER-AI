import { describe, expect, it } from "vitest";
import { estimateSeatsOverLimit, estimateTierUpgrade, type PricedSubscription } from "../estimate";

const sub = (o: Partial<PricedSubscription> = {}): PricedSubscription => ({
  id: "s1",
  status: "ACTIVE",
  interval: "YEAR",
  amountMinor: 3_600_000n,
  currency: "USD",
  quantity: 40,
  contractId: "k1",
  ...o,
});
const input = (o: Partial<Parameters<typeof estimateSeatsOverLimit>[0]> = {}) => ({
  seatsPurchased: 40,
  seatsUsed: 52,
  contractId: "k1",
  subscriptions: [sub()],
  ...o,
});

describe("estimateSeatsOverLimit: money only from the account's own subscription", () => {
  it("12 seats over × $900 per seat = $10,800, always an estimate with its method", () => {
    const e = estimateSeatsOverLimit(input())!;
    expect(e).toMatchObject({
      method: "SEATS_OVER_LIMIT",
      extraSeats: 12,
      perSeatMinor: 90_000n,
      estimateMinor: 1_080_000n,
      currency: "USD",
      isEstimate: true,
      label: "Estimate",
    });
    expect(e.sources).toEqual([{ sourceType: "Subscription", sourceId: "s1" }]);
  });

  it("a monthly subscription is annualised (×12) before the per-seat price", () => {
    const e = estimateSeatsOverLimit(
      input({ subscriptions: [sub({ interval: "MONTH", amountMinor: 300_000n })] }),
    )!;
    expect(e.perSeatMinor).toBe(90_000n);
    expect(e.estimateMinor).toBe(1_080_000n);
  });

  it("no subscription: null estimate labelled 'No price on file', never 0", () => {
    const e = estimateSeatsOverLimit(input({ subscriptions: [] }))!;
    expect(e).toMatchObject({
      estimateMinor: null,
      currency: null,
      perSeatMinor: null,
      isEstimate: true,
      label: "No price on file",
      extraSeats: 12,
    });
  });

  it("a cancelled or ended subscription is not a price", () => {
    for (const status of ["CANCELLED", "ENDED"] as const)
      expect(
        estimateSeatsOverLimit(input({ subscriptions: [sub({ status })] }))!.estimateMinor,
      ).toBeNull();
  });

  it("two live subscriptions on the contract are ambiguous: no number, not a guess", () => {
    const e = estimateSeatsOverLimit(
      input({ subscriptions: [sub(), sub({ id: "s2", amountMinor: 100_000n, quantity: 10 })] }),
    )!;
    expect(e.estimateMinor).toBeNull();
    expect(e.label).toBe("No price on file");
  });

  it("prefers the subscription linked to the contract in force over an unlinked one", () => {
    const e = estimateSeatsOverLimit(
      input({
        subscriptions: [sub({ id: "other", contractId: "k0", amountMinor: 1_000n }), sub()],
      }),
    )!;
    expect(e.estimateMinor).toBe(1_080_000n);
    expect(e.sources[0]!.sourceId).toBe("s1");
  });

  it("a zero price or zero quantity is not a price", () => {
    expect(
      estimateSeatsOverLimit(input({ subscriptions: [sub({ amountMinor: 0n })] }))!.estimateMinor,
    ).toBeNull();
    expect(
      estimateSeatsOverLimit(input({ subscriptions: [sub({ quantity: 0 })] }))!.estimateMinor,
    ).toBeNull();
  });

  it("is not over the limit (or the figures are not on file): no estimate at all", () => {
    expect(estimateSeatsOverLimit(input({ seatsUsed: 40 }))).toBeNull();
    expect(estimateSeatsOverLimit(input({ seatsUsed: 12 }))).toBeNull();
    expect(estimateSeatsOverLimit(input({ seatsPurchased: null }))).toBeNull();
    expect(estimateSeatsOverLimit(input({ seatsUsed: null }))).toBeNull();
  });

  it("is deterministic: the same records give the same figure", () => {
    expect(estimateSeatsOverLimit(input())).toEqual(estimateSeatsOverLimit(input()));
  });
});

describe("estimateTierUpgrade: only their own plan prices, never ours", () => {
  it("without a price for the next plan in their own subscription data: no number", () => {
    expect(
      estimateTierUpgrade({ currentAnnualMinor: 3_600_000n, nextPlanAnnualMinor: null }),
    ).toMatchObject({
      method: "TIER_UPGRADE_DELTA",
      estimateMinor: null,
      isEstimate: true,
      label: "No price on file",
    });
  });
  it("with both prices from their data: the difference", () => {
    expect(
      estimateTierUpgrade({
        currentAnnualMinor: 3_600_000n,
        nextPlanAnnualMinor: 5_000_000n,
        currency: "USD",
      }),
    ).toMatchObject({ estimateMinor: 1_400_000n, currency: "USD", label: "Estimate" });
  });
  it("a next plan that costs no more is not an upgrade: no estimate", () => {
    expect(
      estimateTierUpgrade({
        currentAnnualMinor: 5_000_000n,
        nextPlanAnnualMinor: 5_000_000n,
        currency: "USD",
      }),
    ).toMatchObject({ estimateMinor: null });
  });
});
