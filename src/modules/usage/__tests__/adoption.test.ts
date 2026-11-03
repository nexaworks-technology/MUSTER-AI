import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { adoption, type AdoptionInput } from "../adoption";

/**
 * M6 §5 adoption.test: features used vs bought; seats over/under; power-user retention; decline
 * vs the account's own normal and its cohort. Every figure carries ≥ 1 source; missing data says
 * so and never reads as zero (Rule 4).
 */
const AS_OF = "2026-11-02";
const days = <T>(n: number, from: number, f: (d: string, i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => f(addDays(AS_OF, -(from - i)), i));

const input = (over: Partial<AdoptionInput> = {}): AdoptionInput => ({
  accountId: "a1",
  asOf: AS_OF,
  plan: "Growth",
  contract: { id: "c1", seatsPurchased: 15, creditsPurchased: null, startDate: "2026-09-30" },
  usage: days(28, 28, (date, i) => ({
    id: `u${i}`,
    date,
    activeUsers: 3,
    seatsUsed: 3,
    creditsUsed: null,
  })),
  userUsage: [
    ...days(20, 56, (date) => ({ externalUserId: "mei", name: "Mei Chen", date, events: 40 })),
    ...days(20, 56, (date) => ({ externalUserId: "raj", name: "Raj Patel", date, events: 30 })),
    ...days(20, 56, (date) => ({ externalUserId: "low", name: "Low User", date, events: 1 })),
    ...days(10, 10, (date) => ({ externalUserId: "mei", name: "Mei Chen", date, events: 25 })),
  ],
  featureUsage: [
    { featureKey: "dashboards", date: "2026-10-10", users: 3 },
    { featureKey: "scheduled_reports", date: "2026-10-12", users: 1 },
  ],
  catalog: [
    {
      featureKey: "dashboards",
      label: "Dashboards",
      isKeyFeature: true,
      includedInPlans: ["Growth", "Pro"],
    },
    {
      featureKey: "scheduled_reports",
      label: "Scheduled reports",
      isKeyFeature: true,
      includedInPlans: ["Growth"],
    },
    {
      featureKey: "data_connectors",
      label: "Data connectors",
      isKeyFeature: true,
      includedInPlans: ["Growth"],
    },
    { featureKey: "alerts", label: "Alerts", isKeyFeature: false, includedInPlans: ["Growth"] },
    {
      featureKey: "api_access",
      label: "API access",
      isKeyFeature: false,
      includedInPlans: ["Growth"],
    },
    { featureKey: "sso", label: "SSO", isKeyFeature: false, includedInPlans: ["Pro"] },
  ],
  ownNormal: { median: 6, from: "2026-07-21", to: "2026-10-19" },
  cohort: { label: "Mid-touch accounts on the Growth plan", size: 7, medianRate: 0.54 },
  ...over,
});

describe("adoption (CS language, every figure with sources)", () => {
  it("features used vs bought: '3 of 5 features in your Growth plan have never been used'", () => {
    const a = adoption(input());
    expect(a.features).toMatchObject({
      bought: 5,
      neverUsed: ["Data connectors", "Alerts", "API access"],
      text: "3 of 5 features in your Growth plan have never been used",
    });
    expect(a.features!.sources.length).toBeGreaterThan(0);
  });

  it("seats: under-used and over-used, each said plainly", () => {
    expect(adoption(input()).seats).toMatchObject({
      used: 3,
      purchased: 15,
      status: "UNDER",
      text: "3 of 15 seats in use (20%)",
    });
    const over = adoption(
      input({
        usage: days(3, 3, (date, i) => ({
          id: `x${i}`,
          date,
          activeUsers: 18,
          seatsUsed: 18,
          creditsUsed: null,
        })),
      }),
    );
    expect(over.seats).toMatchObject({
      status: "OVER",
      text: "18 of 15 seats in use (120%): more than bought",
    });
    expect(over.seats!.sources).toEqual([
      { sourceType: "UsageDaily", sourceId: "x2", value: 18, date: "2026-11-01" },
    ]);
  });

  it("power users from the month before and how many are still active", () => {
    const p = adoption(input()).powerUsers!;
    expect(p.text).toBe("1 of 2 power users from the month before is still active");
    expect(p.users).toEqual([
      { name: "Mei Chen", stillActive: true },
      { name: "Raj Patel", stillActive: false },
    ]);
    expect(p.sources.length).toBeGreaterThan(0);
  });

  it("decline: typical weekday use against the account's own normal, then its cohort", () => {
    const t = adoption(input()).trend!;
    expect(t.text).toBe("Weekday use is at 50% of this account's normal (3 people vs 6)");
    expect(t.cohortText).toBe(
      "Similar accounts (Mid-touch accounts on the Growth plan, 7 peers) have 54% of seats active on a typical weekday; this account has 20%",
    );
    expect(t.sources.length).toBeGreaterThan(0);
  });

  it("missing data says so, and nothing reads as zero (Rule 4)", () => {
    const a = adoption(
      input({
        usage: null,
        userUsage: null,
        featureUsage: null,
        contract: null,
        ownNormal: null,
        cohort: null,
      }),
    );
    expect(a.seats).toBeNull();
    expect(a.features).toBeNull();
    expect(a.powerUsers).toBeNull();
    expect(a.trend).toBeNull();
    expect(a.missing).toEqual([
      "No contract on file, so seats bought are unknown.",
      "No product usage data for this account yet.",
      "No per-person usage data, so power users cannot be shown.",
      "No feature usage data, so features used cannot be shown.",
    ]);
  });

  it("every figure that is shown has at least one source", () => {
    const a = adoption(input());
    for (const f of [a.seats, a.features, a.powerUsers, a.trend])
      expect(f!.sources.length).toBeGreaterThan(0);
  });
});
