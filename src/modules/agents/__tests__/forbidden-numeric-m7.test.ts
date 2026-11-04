import { describe, expect, it } from "vitest";
import { evaluateOutput } from "../evaluate";
import { getAgent } from "../registry";

/**
 * M7 §5 forbidden-numeric: when the renewal-manager's proposed actions carry a confidence, an ARR
 * at risk or an expansion estimate, code overwrites them with the deterministic values before
 * anything is stored, and drops the ones code has no value for. (Its text carries no number at
 * all: that is the placeholder rule, tested in the golden replay and narrative-placeholders.)
 */
const def = getAgent("renewal-manager");
const bundle = [
  {
    sourceType: "Renewal",
    sourceId: "ren1",
    fields: { account: "Northgate Freight", renewalDate: "Dec 13, 2026" },
  },
];
const base = {
  reasoningSummary: "Renewal soon.",
  confidence: 0.6,
  citations: [{ sourceType: "Renewal", sourceId: "ren1" }],
  planSteps: [],
  talkTrack: [],
  outreach: { subject: null, body: null },
  nextStep: null,
};

describe("forbidden numeric fields", () => {
  it("lists exactly confidence, arrAtRisk and expansionEstimate", () => {
    expect([...def.forbiddenNumericFields]).toEqual([
      "confidence",
      "arrAtRisk",
      "expansionEstimate",
    ]);
  });

  it("overwrites model-supplied values with the records' figures", () => {
    const e = evaluateOutput(
      def,
      bundle,
      {
        ...base,
        proposedActions: [
          {
            type: "PLAN",
            summary: "Plan the renewal",
            confidence: 0.99,
            arrAtRisk: 5,
            expansionEstimate: 7,
          },
        ],
      },
      { confidence: 70, arrAtRisk: 14_200_000, expansionEstimate: 1_080_000 },
    );
    expect(e.status).toBe("SUCCEEDED");
    if (e.status !== "SUCCEEDED") return;
    expect(e.output.proposedActions[0]).toMatchObject({
      confidence: 70,
      arrAtRisk: 14_200_000,
      expansionEstimate: 1_080_000,
    });
  });

  it("drops a figure code has no value for (no ARR on file: none is invented)", () => {
    const e = evaluateOutput(
      def,
      bundle,
      {
        ...base,
        proposedActions: [
          { type: "PLAN", summary: "Plan", confidence: 0.2, arrAtRisk: 9, expansionEstimate: 4 },
        ],
      },
      { confidence: 70 },
    );
    expect(e.status).toBe("SUCCEEDED");
    if (e.status !== "SUCCEEDED") return;
    const a = e.output.proposedActions[0]!;
    expect(a).toMatchObject({ confidence: 70 });
    expect(a).not.toHaveProperty("arrAtRisk");
    expect(a).not.toHaveProperty("expansionEstimate");
  });
});
