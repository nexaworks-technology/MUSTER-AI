import { describe, expect, it } from "vitest";
import { aggregate, type ComponentResults } from "../engine/aggregate";
import { DEFAULT_MODEL, PILLARS, type ModelConfig } from "../engine/model";
import type { ComponentResult } from "../engine/types";

/**
 * CSM Pulse (INTERP-2, M3 rule 10): a real input inside Relationship (30%), valid 30 days,
 * never a silent override. Disagreement compares the Pulse with the score WITHOUT the Pulse.
 */
const ev = (component: string, score: number): ComponentResult => ({
  score,
  reason: {
    component,
    kind: "EVIDENCE",
    input: component,
    message: component,
    sources: [{ sourceType: "Test", sourceId: component }],
  },
});
const none = (component: string): ComponentResult => ({
  score: null,
  reason: { component, kind: "MISSING_DATA", input: component, message: component, sources: [] },
});
const pulse = (value: "FINE" | "WORRIED" | null): ComponentResult =>
  value === null
    ? none("pulse")
    : {
        score: value === "FINE" ? 100 : 20,
        reason: {
          component: "pulse",
          kind: "EVIDENCE",
          input: "csm_pulse",
          message: value,
          sources: [{ sourceType: "CsmPulse", sourceId: `p-${value}` }],
        },
      };

/** Every pillar at `level`, Relationship built from real components plus the Pulse. */
function account(level: number, p: "FINE" | "WORRIED" | null): ComponentResults {
  const base = Object.fromEntries(
    PILLARS.map((x) => [x, { main: x === "SENTIMENT" ? none("s") : ev(`${x}.main`, level) }]),
  ) as unknown as ComponentResults;
  return {
    ...base,
    RELATIONSHIP: {
      champion_present: ev("champion_present", level),
      decision_maker: ev("decision_maker", level),
      breadth: ev("breadth", level),
      champion_change_90d: ev("champion_change_90d", level),
      nps_decision_makers: none("nps_decision_makers"),
      pulse: pulse(p),
    },
  };
}
const MODEL: ModelConfig = {
  ...DEFAULT_MODEL,
  componentConfig: {
    ...Object.fromEntries(PILLARS.map((x) => [x, { main: { weight: 1 } }])),
    RELATIONSHIP: DEFAULT_MODEL.componentConfig.RELATIONSHIP!,
  },
};

describe("CSM Pulse", () => {
  it("is 30% of Relationship: Worried pulls it down, Fine pulls it up", () => {
    // Relationship components at 80 (weights 30+15+15+10 = 70) and the Pulse (30).
    expect(aggregate(account(80, null), MODEL, "HIGH_TOUCH").pillars.RELATIONSHIP).toBe(80);
    // (70·80 + 30·20) / 100 = 62
    expect(aggregate(account(80, "WORRIED"), MODEL, "HIGH_TOUCH").pillars.RELATIONSHIP).toBe(62);
    // (70·80 + 30·100) / 100 = 86
    expect(aggregate(account(80, "FINE"), MODEL, "HIGH_TOUCH").pillars.RELATIONSHIP).toBe(86);
  });

  it("keeps the score as computed and stores the score without the Pulse beside it", () => {
    const r = aggregate(account(85, "WORRIED"), MODEL, "HIGH_TOUCH");
    expect(r.overallExcludingPulse).toBe(85);
    // Relationship 65.5 at 22.2% → overall 85 − 0.2222·19.5 = 80.67; still Healthy by the numbers.
    expect(r.overall).toBe(80.67);
    expect(r.riskLevel).toBe("HEALTHY");
    expect(r.pulse).toEqual({ id: "p-WORRIED", value: "WORRIED" });
  });

  it("flags disagreement both ways, against the score without the Pulse", () => {
    const worriedHealthy = aggregate(account(85, "WORRIED"), MODEL, "HIGH_TOUCH");
    expect(worriedHealthy.riskLevelExcludingPulse).toBe("HEALTHY");
    expect(worriedHealthy.pulseDisagreement).toBe(true);

    const fineAtRisk = aggregate(account(30, "FINE"), MODEL, "MID_TOUCH");
    expect(fineAtRisk.riskLevelExcludingPulse).toBe("AT_RISK");
    expect(fineAtRisk.pulseDisagreement).toBe(true);
    // The human's Fine raises the number a little but does not hide the risk.
    expect(fineAtRisk.overall!).toBeGreaterThan(fineAtRisk.overallExcludingPulse!);
    expect(fineAtRisk.riskLevel).toBe("AT_RISK");
  });

  it("agreeing pulses are not disagreements; no pulse means no disagreement", () => {
    expect(aggregate(account(85, "FINE"), MODEL, "HIGH_TOUCH").pulseDisagreement).toBe(false);
    expect(aggregate(account(30, "WORRIED"), MODEL, "MID_TOUCH").pulseDisagreement).toBe(false);
    expect(aggregate(account(55, "WORRIED"), MODEL, "MID_TOUCH").pulseDisagreement).toBe(false);
    const none = aggregate(account(85, null), MODEL, "HIGH_TOUCH");
    expect(none.pulseDisagreement).toBe(false);
    expect(none.pulse).toBeNull();
    expect(none.overall).toBe(none.overallExcludingPulse);
  });
});
