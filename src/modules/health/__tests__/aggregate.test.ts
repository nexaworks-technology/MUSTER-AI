import { describe, expect, it } from "vitest";
import { aggregate, type ComponentResults } from "../engine/aggregate";
import { DEFAULT_MODEL, PILLARS, type ModelConfig, type Pillar } from "../engine/model";
import type { ComponentResult } from "../engine/types";

/**
 * ARCHITECTURE §4.3, INTERP-1, M3 rule 3: overall = Σ(w·pillar)/Σ(w) over pillars WITH data;
 * missing data never lowers a score; < 2 pillars → "Not enough data"; At Risk names a reason.
 */
const ev = (component: string, score: number, sourceId = component): ComponentResult => ({
  score,
  reason: {
    component,
    kind: "EVIDENCE",
    input: component,
    message: `${component} = ${score}`,
    sources: [{ sourceType: "Test", sourceId }],
  },
});
const none = (component: string): ComponentResult => ({
  score: null,
  reason: {
    component,
    kind: "MISSING_DATA",
    input: component,
    message: `${component}: no data`,
    sources: [],
  },
});

/** One component per pillar carrying the whole pillar (weights from a 1-component model). */
const ONE: ModelConfig = {
  ...DEFAULT_MODEL,
  componentConfig: Object.fromEntries(PILLARS.map((p) => [p, { main: { weight: 1 } }])),
};
const pillars = (scores: Partial<Record<Pillar, number | null>>): ComponentResults =>
  Object.fromEntries(
    PILLARS.map((p) => {
      const s = scores[p];
      return [p, { main: s === undefined || s === null ? none(`${p}.main`) : ev(`${p}.main`, s) }];
    }),
  ) as unknown as ComponentResults;

describe("overall score", () => {
  it("renormalises the weights over the pillars that have data (worked example)", () => {
    const r = aggregate(
      pillars({ ADOPTION: 80, ENGAGEMENT: 60, SUPPORT: 100, RELATIONSHIP: 50, COMMERCIAL: 90 }),
      ONE,
      "MID_TOUCH",
    );
    // (0.30·80 + 0.15·60 + 0.15·100 + 0.20·50 + 0.10·90) / 0.90 = 67 / 0.9
    expect(r.overall).toBe(74.44);
    expect(r.pillars.SENTIMENT).toBeNull();
    expect(r.effectiveWeights).toEqual({
      ADOPTION: 0.3333,
      ENGAGEMENT: 0.1667,
      SUPPORT: 0.1667,
      RELATIONSHIP: 0.2222,
      COMMERCIAL: 0.1111,
      SENTIMENT: null,
    });
    expect(r.riskLevel).toBe("HEALTHY");
  });

  it("missing data never lowers a score: a no-data pillar equals the pillar not existing", () => {
    const withNull = aggregate(
      pillars({ ADOPTION: 80, SUPPORT: 40, RELATIONSHIP: 90 }),
      ONE,
      "MID_TOUCH",
    );
    const without: ModelConfig = {
      ...ONE,
      pillarWeights: {
        ...ONE.pillarWeights,
        ENGAGEMENT: 0,
        COMMERCIAL: 0,
        SENTIMENT: 0,
        ADOPTION: 0.3 / 0.65,
        SUPPORT: 0.15 / 0.65,
        RELATIONSHIP: 0.2 / 0.65,
      },
    };
    const asIfAbsent = aggregate(
      pillars({ ADOPTION: 80, SUPPORT: 40, RELATIONSHIP: 90 }),
      without,
      "MID_TOUCH",
    );
    expect(withNull.overall).toBe(asIfAbsent.overall);
    const asZero = aggregate(
      pillars({ ADOPTION: 80, SUPPORT: 40, RELATIONSHIP: 90, ENGAGEMENT: 0 }),
      ONE,
      "MID_TOUCH",
    );
    expect(withNull.overall!).toBeGreaterThan(asZero.overall!);
  });

  it("shows each excluded pillar and where its weight went", () => {
    const r = aggregate(pillars({ ADOPTION: 80, SUPPORT: 40 }), ONE, "MID_TOUCH");
    const notes = r.reasons.filter((x) => x.component === "pillar_excluded").map((x) => x.message);
    expect(notes).toContain(
      "Sentiment excluded: no data. Its 10% weight is spread across the pillars that have data.",
    );
    expect(notes).toHaveLength(4);
  });

  it("with fewer than 2 pillars of data the level is Not enough data, never At Risk", () => {
    const r = aggregate(pillars({ ADOPTION: 5 }), ONE, "MID_TOUCH");
    expect(r.overall).toBeNull();
    expect(r.riskLevel).toBe("INSUFFICIENT_DATA");
    expect(r.riskReasonIndex).toBeNull();
    expect(aggregate(pillars({}), ONE, "MID_TOUCH").riskLevel).toBe("INSUFFICIENT_DATA");
  });

  it("puts the threshold edges in the right band (44.99 / 45 / 69.99 / 70)", () => {
    const band = (x: number) => aggregate(pillars({ ADOPTION: x, SUPPORT: x }), ONE, "MID_TOUCH");
    expect(band(44.99)).toMatchObject({ overall: 44.99, riskLevel: "AT_RISK" });
    expect(band(45)).toMatchObject({ overall: 45, riskLevel: "WATCH" });
    expect(band(69.99)).toMatchObject({ overall: 69.99, riskLevel: "WATCH" });
    expect(band(70)).toMatchObject({ overall: 70, riskLevel: "HEALTHY" });
    // Classified on the stored (2-decimal) value, so the band always matches what is shown.
    expect(band(69.996)).toMatchObject({ overall: 70, riskLevel: "HEALTHY" });
  });

  it("applies per-tier thresholds", () => {
    const model: ModelConfig = {
      ...ONE,
      perTierOverrides: { HIGH_TOUCH: { healthyMin: 80, watchMin: 55 } },
    };
    const s = pillars({ ADOPTION: 75, SUPPORT: 75 });
    expect(aggregate(s, model, "HIGH_TOUCH").riskLevel).toBe("WATCH");
    expect(aggregate(s, model, "MID_TOUCH").riskLevel).toBe("HEALTHY");
  });
});

describe("pillars and reasons", () => {
  it("averages components inside a pillar, renormalising over those with data", () => {
    const r = aggregate(
      {
        ...pillars({ SUPPORT: 100 }),
        ADOPTION: {
          active_vs_own: ev("active_vs_own", 40),
          active_rate_vs_cohort: none("active_rate_vs_cohort"),
          seat_use: ev("seat_use", 80),
          key_features: none("key_features"),
          power_users: none("power_users"),
        },
      } as unknown as ComponentResults,
      DEFAULT_MODEL,
      "MID_TOUCH",
    );
    // (35·40 + 15·80) / 50 = 52
    expect(r.pillars.ADOPTION).toBe(52);
  });

  it("reason impacts add up to (overall − 100)", () => {
    const r = aggregate(
      pillars({ ADOPTION: 28.6, ENGAGEMENT: 12, SUPPORT: 80, RELATIONSHIP: 31, COMMERCIAL: 100 }),
      ONE,
      "HIGH_TOUCH",
    );
    const sum = r.reasons.reduce((s, x) => s + x.impact, 0);
    expect(Math.abs(sum - (r.overall! - 100))).toBeLessThan(0.02);
    expect(r.reasons.filter((x) => x.kind === "MISSING_DATA").every((x) => x.impact === 0)).toBe(
      true,
    );
  });

  it("At Risk names its most negative evidence reason (ties: pillar order, then name)", () => {
    const r = aggregate(pillars({ ADOPTION: 10, RELATIONSHIP: 10, SUPPORT: 60 }), ONE, "MID_TOUCH");
    expect(r.riskLevel).toBe("AT_RISK");
    const top = r.reasons[r.riskReasonIndex!]!;
    // Adoption 30% vs Relationship 20%: Adoption's 10 costs more points.
    expect(top).toMatchObject({ pillar: "ADOPTION", kind: "EVIDENCE", direction: "DOWN" });
    const tie = aggregate(
      {
        ...pillars({ SUPPORT: 10, COMMERCIAL: 100 }),
        ENGAGEMENT: { main: ev("b", 10) },
      } as unknown as ComponentResults,
      { ...ONE, pillarWeights: { ...ONE.pillarWeights } },
      "MID_TOUCH",
    );
    expect(tie.reasons[tie.riskReasonIndex!]!.pillar).toBe("ENGAGEMENT");
  });

  it("marks directions: 90+ up, 60–89 neutral, below 60 down", () => {
    const r = aggregate(pillars({ ADOPTION: 95, SUPPORT: 70, RELATIONSHIP: 30 }), ONE, "MID_TOUCH");
    const dir = (p: Pillar) =>
      r.reasons.find((x) => x.pillar === p && x.kind === "EVIDENCE")!.direction;
    expect([dir("ADOPTION"), dir("SUPPORT"), dir("RELATIONSHIP")]).toEqual([
      "UP",
      "NEUTRAL",
      "DOWN",
    ]);
  });

  it("is deterministic: same input, same output", () => {
    const s = pillars({ ADOPTION: 33.3, SUPPORT: 66.6, RELATIONSHIP: 12 });
    expect(aggregate(s, ONE, "LONG_TAIL")).toEqual(aggregate(s, ONE, "LONG_TAIL"));
  });
});
