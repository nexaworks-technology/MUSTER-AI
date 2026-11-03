import { describe, expect, it } from "vitest";
import { timeToValue, type TtvInput, type TtvPeer } from "../ttv";

/**
 * M6 §5 ttv.test (D3): time to value against the account's own target first, then its cohort
 * (M3's chooseCohort: tier → plan → size → use case, minPeers 5), never a guess.
 */
const me = {
  id: "me",
  tier: "MID_TOUCH" as const,
  plan: "Growth",
  employeeBand: "201-1000",
  useCase: null,
};
const peer = (id: string, ttvDays: number, over: Partial<TtvPeer> = {}): TtvPeer => ({
  id,
  tier: "MID_TOUCH",
  plan: "Growth",
  employeeBand: "201-1000",
  useCase: null,
  ttvDays,
  planId: `plan-${id}`,
  ...over,
});
// Median 21, P75 25 among five Growth mid-touch peers of the same size.
const peers = [peer("a", 14), peer("b", 18), peer("c", 21), peer("d", 25), peer("e", 30)];

const base = (over: Partial<TtvInput> = {}): TtvInput => ({
  me,
  asOf: "2026-11-02",
  startDate: "2026-10-01",
  targetDays: 60,
  hasValueDefinition: true,
  valueReachedAt: null,
  valueEvidence: [],
  peers,
  minPeers: 5,
  ...over,
});

describe("time to value (D3)", () => {
  it("value reached on day 18 vs cohort median 21 → on time, with the cohort named", () => {
    const r = timeToValue(
      base({
        valueReachedAt: "2026-10-19",
        valueEvidence: [
          { sourceType: "FeatureUsageDaily", sourceId: "fu1", value: 3, date: "2026-10-19" },
        ],
      }),
    );
    expect(r).toMatchObject({ state: "REACHED", days: 18, verdict: "ON_TIME" });
    expect(r!.cohort).toMatchObject({ size: 5, medianDays: 21, p75Days: 25, fellBack: false });
    expect(r!.reason).toBe(
      "Value reached on day 18. Similar accounts (Mid-touch accounts on the Growth plan with 201-1000 employees, 5 peers) reach it by day 21.",
    );
    expect(r!.sources.map((s) => s.sourceId)).toEqual(
      expect.arrayContaining(["fu1", "plan-a", "plan-e"]),
    );
  });

  it("not reached by the cohort's P75 → late", () => {
    const r = timeToValue(base({ asOf: "2026-11-03" })); // day 33 > P75 25
    expect(r).toMatchObject({ state: "NOT_REACHED", days: 33, verdict: "LATE" });
    expect(r!.reason).toBe(
      "Day 33 and value not reached yet. Similar accounts (Mid-touch accounts on the Growth plan with 201-1000 employees, 5 peers) reach it by day 21; 3 in 4 by day 25.",
    );
  });

  it("not reached but still inside the cohort's range → in progress, not late", () => {
    expect(timeToValue(base({ asOf: "2026-10-20" }))).toMatchObject({
      days: 19,
      verdict: "IN_PROGRESS",
    });
  });

  it("records the cohort fallback in the reason (fewer than 5 similar → tier only)", () => {
    const thin = [
      peer("a", 14),
      peer("b", 18, { plan: "Starter" }),
      peer("c", 21, { plan: "Starter" }),
      peer("d", 25, { plan: "Pro", employeeBand: "1-50" }),
      peer("e", 30, { plan: "Pro" }),
    ];
    const r = timeToValue(base({ asOf: "2026-10-20", peers: thin }));
    expect(r!.cohort).toMatchObject({ label: "Mid-touch accounts", size: 5, fellBack: true });
    expect(r!.reason).toContain(
      "fewer than 5 accounts matched more closely, so all Mid-touch accounts were used",
    );
  });

  it("no value definition on the template → TTV null with the plain reason, never late", () => {
    const r = timeToValue(base({ hasValueDefinition: false, asOf: "2026-12-30" }));
    expect(r).toEqual({
      state: "NO_DEFINITION",
      days: null,
      verdict: null,
      reason: "No value definition for this plan",
      cohort: null,
      ownTargetDays: 60,
      sources: [],
    });
  });

  it("no cohort history at all → compared with the plan's own target only", () => {
    const r = timeToValue(base({ peers: [], asOf: "2026-12-05" })); // day 65 > target 60
    expect(r).toMatchObject({ verdict: "LATE", cohort: null });
    expect(r!.reason).toBe(
      "Day 65 and value not reached yet. The plan's own target was day 60; no similar accounts have reached value yet to compare with.",
    );
  });
});
