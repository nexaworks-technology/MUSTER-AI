import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { cohortBaseline, ownBaseline, type Peer } from "../engine/baselines";
import { runComponent } from "../engine/components";
import type { AccountBundle } from "../engine/types";

/**
 * ARCHITECTURE §4.2: an account's own normal (13 weekly values ending 14–104 days ago) and its
 * cohort (similar accounts, stepwise fallback, ≥ 5 peers). M3 rule 6: identical raw usage can
 * mean different health, because the cohort and the account's own normal differ.
 */
const ASOF = "2026-11-02";
const ago = (n: number) => addDays(ASOF, -n);
const rows = (from: number, users: (daysAgo: number) => number) =>
  Array.from({ length: from }, (_, i) => from - i).map((d) => ({
    id: `u${d}`,
    date: ago(d),
    activeUsers: users(d),
    seatsUsed: null,
  }));

describe("own normal", () => {
  it("is the median and 25th percentile of 13 weekly values ending 14–104 days ago", () => {
    // Weekly values 10, 20, …, 130 (one value per week, constant inside the week).
    const b = ownBaseline(
      rows(120, (d) => (d < 14 ? 0 : (Math.floor((d - 14) / 7) + 1) * 10)),
      ASOF,
    );
    expect(b).toEqual({ median: 70, p25: 40, historyDays: 91, from: ago(104), to: ago(14) });
  });

  it("ignores the last 14 days, so a drop cannot pull its own normal down", () => {
    const steady = ownBaseline(
      rows(120, () => 40),
      ASOF,
    );
    const dropped = ownBaseline(
      rows(120, (d) => (d < 14 ? 5 : 40)),
      ASOF,
    );
    expect(dropped.median).toBe(40);
    expect(dropped).toEqual(steady);
  });

  it("reports how much history there is (the component needs 28 days)", () => {
    const young = ownBaseline(
      rows(34, () => 12),
      ASOF,
    );
    expect(young.historyDays).toBe(21);
    // Weeks before the first day of data are not counted as zero usage.
    expect(young.median).toBe(12);
  });

  it("has no median without any full week of history", () => {
    expect(
      ownBaseline(
        rows(18, () => 12),
        ASOF,
      ),
    ).toMatchObject({ median: null, historyDays: 5 });
    expect(ownBaseline([], ASOF)).toMatchObject({ median: null, p25: null, historyDays: 0 });
  });

  it("ignores rows after the as-of date", () => {
    const base = rows(120, () => 40);
    const leaked = [...base, { id: "f", date: "2026-11-20", activeUsers: 999, seatsUsed: null }];
    expect(ownBaseline(leaked, ASOF)).toEqual(ownBaseline(base, ASOF));
  });
});

describe("cohort", () => {
  const peer = (id: string, o: Partial<Peer> = {}): Peer => ({
    id,
    tier: "MID_TOUCH",
    plan: "Growth",
    employeeBand: "51-200",
    useCase: null,
    rate: 0.5,
    ...o,
  });
  const me = peer("me");

  it("uses the most specific level with at least 5 peers, never counting the account itself", () => {
    const peers = [
      me,
      ...Array.from({ length: 5 }, (_, i) => peer(`p${i}`, { rate: 0.4 + i * 0.05 })),
    ];
    expect(cohortBaseline(me, peers, 5)).toEqual({
      key: "tier=MID_TOUCH|plan=Growth|band=51-200",
      label: "Mid-touch accounts on the Growth plan with 51-200 employees",
      size: 5,
      medianRate: 0.5,
    });
  });

  it("falls back stepwise: drop use case → drop company size → drop plan (tier only)", () => {
    const withUse = { ...me, useCase: "Reporting" };
    const peers = [
      withUse,
      ...Array.from({ length: 5 }, (_, i) => peer(`b${i}`, { employeeBand: "201-1000" })),
    ];
    expect(cohortBaseline(withUse, peers, 5)?.key).toBe("tier=MID_TOUCH|plan=Growth");
    const fewPlan = [
      me,
      ...Array.from({ length: 3 }, (_, i) => peer(`g${i}`)),
      ...Array.from({ length: 3 }, (_, i) => peer(`s${i}`, { plan: "Scale", rate: 0.9 })),
    ];
    expect(cohortBaseline(me, fewPlan, 5)).toMatchObject({
      key: "tier=MID_TOUCH",
      label: "Mid-touch accounts",
      size: 6,
      medianRate: 0.7,
    });
  });

  it("matches the use case only when the account has one", () => {
    const withUse = { ...me, useCase: "Reporting" };
    const peers = [
      withUse,
      ...Array.from({ length: 5 }, (_, i) => peer(`u${i}`, { useCase: "Reporting" })),
    ];
    expect(cohortBaseline(withUse, peers, 5)?.key).toBe(
      "tier=MID_TOUCH|plan=Growth|band=51-200|useCase=Reporting",
    );
  });

  it("reports too few peers instead of inventing a comparison", () => {
    const peers = [me, peer("a"), peer("b"), peer("c", { tier: "HIGH_TOUCH" })];
    expect(cohortBaseline(me, peers, 5)).toEqual({
      key: "tier=MID_TOUCH",
      label: "Mid-touch accounts",
      size: 2,
      medianRate: 0.5,
    });
  });

  it("ignores peers without a usable rate", () => {
    const peers = [me, ...Array.from({ length: 5 }, (_, i) => peer(`n${i}`, { rate: null }))];
    expect(cohortBaseline(me, peers, 5)?.size).toBe(0);
  });
});

describe("the Paperflite lesson (M3 rule 6)", () => {
  it("identical raw usage scores differently when the cohort and own normal differ", () => {
    // Both accounts had 10 typical weekday active users last week.
    const small: AccountBundle = {
      accountId: "small",
      asOf: ASOF,
      tier: "MID_TOUCH",
      plan: "Growth",
      employeeBand: "51-200",
      useCase: null,
      usage: rows(120, () => 10),
      ownBaseline: ownBaseline(
        rows(120, () => 10),
        ASOF,
      ),
      cohort: cohortBaseline(
        {
          id: "small",
          tier: "MID_TOUCH",
          plan: "Growth",
          employeeBand: "51-200",
          useCase: null,
          rate: 10 / 12,
        },
        Array.from({ length: 14 }, (_, i) => ({
          id: `m${i}`,
          tier: "MID_TOUCH" as const,
          plan: "Growth",
          employeeBand: "51-200",
          useCase: null,
          rate: 0.6,
        })),
        5,
      ),
      userUsage: null,
      featureUsage: null,
      keyFeatures: [],
      contract: { id: "ks", seatsPurchased: 12, startDate: ago(300), renewalDate: null },
      messages: null,
      workspaceHasTickets: true,
      tickets: [],
      contacts: [],
      roles: [],
      invoices: [],
      revenueEvents: [],
      pulse: null,
    };
    const big: AccountBundle = {
      ...small,
      accountId: "big",
      tier: "HIGH_TOUCH",
      plan: "Enterprise",
      employeeBand: "1000+",
      // Same 10 users last week, but this account's normal was 40.
      usage: rows(120, (d) => (d <= 7 ? 10 : 40)),
      ownBaseline: ownBaseline(
        rows(120, () => 40),
        ASOF,
      ),
      cohort: cohortBaseline(
        {
          id: "big",
          tier: "HIGH_TOUCH",
          plan: "Enterprise",
          employeeBand: "1000+",
          useCase: null,
          rate: 10 / 200,
        },
        Array.from({ length: 9 }, (_, i) => ({
          id: `h${i}`,
          tier: "HIGH_TOUCH" as const,
          plan: i < 3 ? "Enterprise" : "Scale",
          employeeBand: "1000+",
          useCase: null,
          rate: 0.4,
        })),
        5,
      ),
      contract: { id: "kb", seatsPurchased: 200, startDate: ago(300), renewalDate: null },
    };
    const own = (b: AccountBundle) => runComponent("ADOPTION", "active_vs_own", b);
    const cohort = (b: AccountBundle) => runComponent("ADOPTION", "active_rate_vs_cohort", b);
    expect(own(small).reason.value).toBe(10);
    expect(own(big).reason.value).toBe(10);
    expect(own(small).score).toBe(100);
    expect(own(big).score).toBeCloseTo(6.67, 2);
    expect(cohort(small).score).toBe(100);
    expect(cohort(big).score).toBeCloseTo(2.92, 2);
    expect(cohort(small).reason.message).toBe(
      "83% of 12 seats are active on a typical weekday, against 60% for 14 Mid-touch accounts on the Growth plan with 51-200 employees.",
    );
    expect(cohort(big).reason.message).toBe(
      "5% of 200 seats are active on a typical weekday, against 40% for 9 High-touch accounts.",
    );
  });
});
