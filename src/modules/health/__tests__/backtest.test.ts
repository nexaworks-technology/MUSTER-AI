import { describe, expect, it } from "vitest";
import {
  evaluateModel,
  searchWeights,
  sentence,
  type BacktestPoint,
  type Outcome,
} from "../engine/backtest";
import { DEFAULT_PILLAR_WEIGHTS, DEFAULT_THRESHOLDS, PILLARS, type Pillar } from "../engine/model";

/**
 * Back-test math and the proposal search (ARCHITECTURE §4.5, M3 rules 4–5, D-52, D-55): weekly
 * points over the 120 days before each outcome; a churn is caught if At Risk at a point ≥ 14
 * days before it; lead = outcome − first such At Risk point; a renewal At Risk at any point is a
 * false alarm; accounts with no scorable point are listed, never counted.
 */
const day = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** Weekly points 7…119 days before the outcome; `pillars(daysBefore)` gives that point's pillars. */
function points(
  o: Outcome,
  pillars: (daysBefore: number) => Partial<Record<Pillar, number | null>>,
): BacktestPoint[] {
  return Array.from({ length: 17 }, (_, i) => {
    const daysBefore = 7 * (i + 1);
    const p = pillars(daysBefore);
    return {
      accountId: o.accountId,
      outcomeDate: o.date,
      asOf: day(o.date, daysBefore),
      daysBefore,
      tier: "MID_TOUCH" as const,
      pillars: Object.fromEntries(PILLARS.map((k) => [k, p[k] ?? null])) as Record<
        Pillar,
        number | null
      >,
    };
  });
}

const churn = (id: string, date = "2026-06-01"): Outcome => ({
  accountId: id,
  name: id,
  type: "CHURN",
  date,
});
const renew = (id: string, date = "2026-06-01"): Outcome => ({
  accountId: id,
  name: id,
  type: "RENEWAL",
  date,
});
const healthy = () => ({ ADOPTION: 90, SUPPORT: 90, RELATIONSHIP: 90, COMMERCIAL: 90 });
/** Adoption collapses from `from` days before the outcome; everything else healthy. */
const drop = (from: number) => (d: number) => ({ ...healthy(), ADOPTION: d <= from ? 0 : 90 });
const allDown = (from: number) => (d: number) =>
  d <= from ? { ADOPTION: 10, SUPPORT: 10, RELATIONSHIP: 10, COMMERCIAL: 10 } : healthy();

const DEFAULT = {
  weights: DEFAULT_PILLAR_WEIGHTS,
  thresholds: DEFAULT_THRESHOLDS,
  perTierOverrides: {},
};

describe("back-test evaluation", () => {
  const outcomes = [
    churn("c1"),
    churn("c2"),
    churn("c3"),
    renew("r1"),
    renew("r2"),
    renew("silent"),
  ];
  const pts = [
    ...points(outcomes[0]!, allDown(70)), // caught 70 days early
    ...points(outcomes[1]!, allDown(10)), // At Risk only 7 days before: too late to count
    ...points(outcomes[2]!, () => healthy()), // silent churn: never caught
    ...points(outcomes[3]!, () => healthy()),
    ...points(outcomes[4]!, (d) =>
      d === 49 ? { ADOPTION: 5, SUPPORT: 5, RELATIONSHIP: 5, COMMERCIAL: 5 } : healthy(),
    ), // one dip
    ...points(outcomes[5]!, () => ({ ADOPTION: 50 })), // one pillar only: never scorable
  ];

  it("counts catches (≥ 14 days early), lead times, false alarms, and lists unscorable outcomes", () => {
    const r = evaluateModel(pts, outcomes, DEFAULT);
    expect(r).toMatchObject({
      churns: 3,
      caught: 1,
      renewals: 2,
      falseAlarms: 1,
      meanLeadDays: 70,
      medianLeadDays: 70,
    });
    expect(r.unscorable).toEqual([
      { accountId: "silent", name: "silent", type: "RENEWAL", date: "2026-06-01" },
    ]);
    const c2 = r.accounts.find((a) => a.accountId === "c2")!;
    expect(c2).toMatchObject({ caught: false, leadDays: null });
    expect(c2.points.find((p) => p.daysBefore === 7)?.band).toBe("AT_RISK");
    expect(r.accounts.find((a) => a.accountId === "r2")).toMatchObject({ falseAlarm: true });
  });

  it("mean and median lead are both reported, labelled, never mixed (D-55)", () => {
    const o = [churn("a"), churn("b"), churn("c"), renew("r")];
    const r = evaluateModel(
      [
        ...points(o[0]!, allDown(119)),
        ...points(o[1]!, allDown(28)),
        ...points(o[2]!, allDown(21)),
        ...points(o[3]!, healthy),
      ],
      o,
      DEFAULT,
    );
    expect(r.caught).toBe(3);
    expect(r.meanLeadDays).toBeCloseTo((119 + 28 + 21) / 3, 6);
    expect(r.medianLeadDays).toBe(28);
  });

  it("writes the spec's sentence from the numbers", () => {
    const r = evaluateModel(pts, outcomes, DEFAULT);
    expect(sentence(r)).toBe(
      "With this model, we would have flagged 1 of your last 3 churns, on average 70 days early, with 1 false alarm out of 2 renewals.",
    );
  });

  it("is deterministic and does not depend on input order", () => {
    const shuffled = [...pts].reverse();
    expect(evaluateModel(shuffled, [...outcomes].reverse(), DEFAULT)).toEqual(
      evaluateModel(pts, outcomes, DEFAULT),
    );
  });
});

describe("weight search (the proposal)", () => {
  // Five churns where only Adoption collapses, five clean renewals: the default (Adoption 30%)
  // averages the collapse away; the search should find weights that catch them.
  const outcomes = [
    ...["a", "b", "c", "d", "e"].map((x) => churn(x)),
    ...["r1", "r2", "r3", "r4", "r5"].map((x) => renew(x)),
  ];
  const pts = outcomes.flatMap((o) => points(o, o.type === "CHURN" ? drop(60) : () => healthy()));

  it("beats a weak default on the workspace's own outcomes", () => {
    const base = evaluateModel(pts, outcomes, DEFAULT);
    const s = searchWeights(pts, outcomes, { step: 0.05 });
    expect(base.caught).toBe(0);
    expect(s.sufficient).toBe(true);
    expect(s.best.result.caught).toBe(5);
    expect(s.best.result.falseAlarms).toBe(0);
    // Thresholds are searched too: here the default weights already catch every churn once Watch
    // starts at 55 (they score 54), and the tie-break keeps the weights closest to the default.
    expect(s.best.weights).toEqual(DEFAULT_PILLAR_WEIGHTS);
    expect(s.best.thresholds.watchMin).toBe(55);
    expect(s.runnerUp).not.toBeNull();
    // A pillar with no data anywhere keeps its default weight (nothing is made up for it).
    expect(s.best.weights.SENTIMENT).toBe(DEFAULT_PILLAR_WEIGHTS.SENTIMENT);
    expect(PILLARS.reduce((t, p) => t + s.best.weights[p], 0)).toBeCloseTo(1, 9);
  });

  it("is deterministic: same input, same proposal, whatever the order", () => {
    const a = searchWeights(pts, outcomes, { step: 0.1 });
    const b = searchWeights([...pts].reverse(), [...outcomes].reverse(), { step: 0.1 });
    expect(b.best).toEqual(a.best);
    expect(b.runnerUp).toEqual(a.runnerUp);
  });

  it("cannot shrink its own denominators by ignoring pillars that have data", () => {
    // Three renewals whose only data is Adoption (which dips like the churns) and Engagement. A
    // candidate that zeroed Engagement would make them "not enough data" and hide their false
    // alarms. Every candidate is judged on the same accounts, and no pillar with data is ignored.
    const traps = ["t1", "t2", "t3"].map((x) => renew(x));
    const o = [...outcomes, ...traps];
    const all = [
      ...pts,
      ...traps.flatMap((r) => points(r, (d) => ({ ADOPTION: d <= 60 ? 0 : 90, ENGAGEMENT: 90 }))),
    ];
    const s = searchWeights(all, o, { step: 0.05 });
    const base = evaluateModel(all, o, DEFAULT);
    expect([s.best.result.churns, s.best.result.renewals]).toEqual([base.churns, base.renewals]);
    expect(s.best.result.renewals).toBe(8);
    expect(s.best.result.unscorable).toEqual([]);
    for (const p of ["ADOPTION", "ENGAGEMENT", "SUPPORT", "RELATIONSHIP", "COMMERCIAL"] as const)
      expect(s.best.weights[p], p).toBeGreaterThanOrEqual(0.05);
    expect(s.best.result.falseAlarms / s.best.result.renewals).toBeLessThanOrEqual(0.25);
  });

  it("keeps false alarms at or under 25% of renewals", () => {
    const noisy = [
      ...pts,
      // Two renewals that dip in Adoption too: a pure-Adoption model would flag them.
      ...points(renew("n1"), drop(60)),
      ...points(renew("n2"), drop(60)),
    ];
    const s = searchWeights(noisy, [...outcomes, renew("n1"), renew("n2")], { step: 0.1 });
    expect(s.best.result.falseAlarms / s.best.result.renewals).toBeLessThanOrEqual(0.25);
  });

  it("with no history at all, returns the default model, marked insufficient", () => {
    const s = searchWeights([], []);
    expect(s).toMatchObject({ sufficient: false, evaluated: 0, runnerUp: null });
    expect(s.best.weights).toEqual(DEFAULT_PILLAR_WEIGHTS);
  });

  it("needs ≥ 5 scorable churns and ≥ 5 renewals, else it proposes nothing", () => {
    const few = outcomes.filter((o) => o.accountId !== "a");
    const s = searchWeights(pts, few, { step: 0.1 });
    expect(s.sufficient).toBe(false);
    expect(s.reason).toBe(
      "4 churned and 5 renewed accounts could be scored; 5 of each are needed.",
    );
  });
});
