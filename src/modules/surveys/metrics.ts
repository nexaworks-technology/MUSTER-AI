import type { SurveyType } from "@prisma/client";

/**
 * Pure calculation of survey metrics (spec §5, §6J5, CLAUDE.md Rule 4).
 * No LLM touches a survey number. Every metric explicitly includes sample size n.
 */

export interface SurveyMetricsResult {
  type: SurveyType;
  n: number;
  score: number | null;
  averageScore: number | null;
  promoters?: number;
  passives?: number;
  detractors?: number;
}

export function computeSurveyMetrics(
  type: SurveyType,
  responses: Array<{ score: number }>,
): SurveyMetricsResult {
  const n = responses.length;
  if (n === 0) {
    if (type === "NPS") {
      return {
        type: "NPS",
        n: 0,
        score: null,
        promoters: 0,
        passives: 0,
        detractors: 0,
        averageScore: null,
      };
    }
    return {
      type,
      n: 0,
      score: null,
      averageScore: null,
    };
  }

  const sum = responses.reduce((acc, r) => acc + r.score, 0);
  const averageScore = Math.round((sum / n) * 10) / 10;

  if (type === "NPS") {
    // NPS scores are 0-10: 9-10 Promoters, 7-8 Passives, 0-6 Detractors
    let promoters = 0;
    let passives = 0;
    let detractors = 0;
    for (const r of responses) {
      if (r.score >= 9) promoters++;
      else if (r.score >= 7) passives++;
      else detractors++;
    }
    const score = Math.round(((promoters - detractors) / n) * 100);
    return {
      type: "NPS",
      n,
      score,
      promoters,
      passives,
      detractors,
      averageScore,
    };
  }

  if (type === "CSAT") {
    // CSAT: 1-5 scale, % satisfied (4 or 5)
    const satisfied = responses.filter((r) => r.score >= 4).length;
    const score = Math.round((satisfied / n) * 100);
    return {
      type: "CSAT",
      n,
      score,
      averageScore,
    };
  }

  if (type === "CES") {
    // CES: 1-7 scale, % low effort (>= 5)
    const lowEffort = responses.filter((r) => r.score >= 5).length;
    const score = Math.round((lowEffort / n) * 100);
    return {
      type: "CES",
      n,
      score,
      averageScore,
    };
  }

  return {
    type,
    n,
    score: averageScore,
    averageScore,
  };
}
