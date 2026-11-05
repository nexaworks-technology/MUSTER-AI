import { describe, expect, it } from "vitest";
import { computeSurveyMetrics } from "../metrics";

describe("computeSurveyMetrics (pure calculation, no LLM)", () => {
  it("computes NPS correctly with promoters, passives, detractors, and sample size n", () => {
    // NPS: 0-6 Detractors, 7-8 Passives, 9-10 Promoters
    // NPS = ((promoters - detractors) / n) * 100
    const responses = [
      { score: 10 }, // promoter
      { score: 9 },  // promoter
      { score: 8 },  // passive
      { score: 7 },  // passive
      { score: 4 },  // detractor
    ];
    const metrics = computeSurveyMetrics("NPS", responses);
    expect(metrics).toEqual({
      type: "NPS",
      n: 5,
      score: 20, // (2 - 1) / 5 * 100 = 20
      promoters: 2,
      passives: 2,
      detractors: 1,
      averageScore: 7.6,
    });
  });

  it("computes 100% detractor NPS correctly", () => {
    const responses = [{ score: 4 }];
    const metrics = computeSurveyMetrics("NPS", responses);
    expect(metrics).toEqual({
      type: "NPS",
      n: 1,
      score: -100, // (0 - 1) / 1 * 100 = -100
      promoters: 0,
      passives: 0,
      detractors: 1,
      averageScore: 4,
    });
  });

  it("handles empty NPS responses honestly with score null and n 0", () => {
    const metrics = computeSurveyMetrics("NPS", []);
    expect(metrics).toEqual({
      type: "NPS",
      n: 0,
      score: null,
      promoters: 0,
      passives: 0,
      detractors: 0,
      averageScore: null,
    });
  });

  it("computes CSAT average and percentage satisfied (score >= 4)", () => {
    // CSAT: 1-5 scale
    const responses = [
      { score: 5 },
      { score: 4 },
      { score: 3 },
      { score: 2 },
    ];
    const metrics = computeSurveyMetrics("CSAT", responses);
    expect(metrics).toEqual({
      type: "CSAT",
      n: 4,
      score: 50, // 2 out of 4 satisfied (>=4) = 50%
      averageScore: 3.5,
    });
  });

  it("computes CES average and percentage low-effort (score >= 5)", () => {
    // CES: 1-7 scale
    const responses = [
      { score: 6 },
      { score: 7 },
      { score: 5 },
      { score: 2 },
    ];
    const metrics = computeSurveyMetrics("CES", responses);
    expect(metrics).toEqual({
      type: "CES",
      n: 4,
      score: 75, // 3 out of 4 low effort (>=5) = 75%
      averageScore: 5,
    });
  });
});
