import { PILLAR_LABELS, PILLARS, type ModelConfig, type Pillar } from "./model";
import type { ComponentResult, ReasonDraft, Tier } from "./types";

/**
 * Pillars → overall → risk level (ARCHITECTURE §4.3, INTERP-1, INTERP-2). Pure.
 *
 * - A pillar is the weighted mean of its components that have data; none → null ("no data").
 * - overall = Σ(w·pillar)/Σ(w) over pillars with data; fewer than 2 → INSUFFICIENT_DATA.
 * - Each reason's impact = effective pillar weight × effective component weight × (score − 100),
 *   so the impacts add up to (overall − 100) and every point is accounted for.
 * - At Risk names its most negative evidence reason.
 * - The Pulse is a Relationship component; the score without it decides disagreement.
 */
export type ComponentResults = Record<Pillar, Record<string, ComponentResult>>;
export type RiskLevel = "HEALTHY" | "WATCH" | "AT_RISK" | "INSUFFICIENT_DATA";
export type Direction = "UP" | "DOWN" | "NEUTRAL";

export interface ScoredReason extends ReasonDraft {
  pillar: Pillar;
  score: number | null;
  impact: number;
  direction: Direction;
  sortOrder: number;
}

export interface Aggregate {
  overall: number | null;
  overallExcludingPulse: number | null;
  pillars: Record<Pillar, number | null>;
  effectiveWeights: Record<Pillar, number | null>;
  riskLevel: RiskLevel;
  riskLevelExcludingPulse: RiskLevel;
  riskReasonIndex: number | null;
  reasons: ScoredReason[];
  pulse: { id: string; value: "FINE" | "WORRIED" } | null;
  pulseDisagreement: boolean;
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

function pillarScores(results: ComponentResults, model: ModelConfig, skip?: string) {
  const out = {} as Record<Pillar, { score: number | null; weights: Map<string, number> }>;
  for (const p of PILLARS) {
    const weights = new Map<string, number>();
    let sum = 0;
    let total = 0;
    for (const [name, r] of Object.entries(results[p] ?? {})) {
      const w = model.componentConfig[p]?.[name]?.weight ?? 0;
      if (name === skip || r.score === null || w <= 0) continue;
      weights.set(name, w);
      sum += w * r.score;
      total += w;
    }
    for (const [k, w] of weights) weights.set(k, w / total);
    out[p] = { score: total > 0 ? sum / total : null, weights };
  }
  return out;
}

function overallOf(scores: Record<Pillar, { score: number | null }>, model: ModelConfig) {
  let sum = 0;
  let total = 0;
  let n = 0;
  for (const p of PILLARS) {
    const w = model.pillarWeights[p];
    const s = scores[p].score;
    if (s === null || w <= 0) continue;
    sum += w * s;
    total += w;
    n++;
  }
  return { overall: n >= 2 ? sum / total : null, total };
}

export function band(overall: number | null, model: ModelConfig, tier: Tier): RiskLevel {
  if (overall === null) return "INSUFFICIENT_DATA";
  const t = model.perTierOverrides?.[tier] ?? model.thresholds;
  const x = round2(overall);
  return x >= t.healthyMin ? "HEALTHY" : x >= t.watchMin ? "WATCH" : "AT_RISK";
}

const direction = (score: number): Direction =>
  score >= 90 ? "UP" : score >= 60 ? "NEUTRAL" : "DOWN";

export function aggregate(results: ComponentResults, model: ModelConfig, tier: Tier): Aggregate {
  const scores = pillarScores(results, model);
  const { overall, total } = overallOf(scores, model);
  const riskLevel = band(overall, model, tier);

  const reasons: ScoredReason[] = [];
  for (const p of PILLARS) {
    const pillarShare =
      scores[p].score === null || overall === null ? 0 : model.pillarWeights[p] / total;
    for (const [name, r] of Object.entries(results[p] ?? {})) {
      const share = scores[p].weights.get(name) ?? 0;
      reasons.push({
        ...r.reason,
        pillar: p,
        score: r.score === null ? null : round2(r.score),
        impact: r.score === null ? 0 : round2(pillarShare * share * (r.score - 100)),
        direction: r.score === null ? "NEUTRAL" : direction(r.score),
        sortOrder: reasons.length,
      });
    }
    if (scores[p].score === null && model.pillarWeights[p] > 0)
      reasons.push({
        component: "pillar_excluded",
        kind: "MISSING_DATA",
        input: p.toLowerCase(),
        message: `${PILLAR_LABELS[p]} excluded: no data. Its ${Math.round(model.pillarWeights[p] * 100)}% weight is spread across the pillars that have data.`,
        sources: [],
        pillar: p,
        score: null,
        impact: 0,
        direction: "NEUTRAL",
        sortOrder: reasons.length,
      });
  }

  let riskReasonIndex: number | null = null;
  if (riskLevel === "AT_RISK") {
    let best = Infinity;
    reasons.forEach((r, i) => {
      // Reasons are already in pillar order then component order, so the first minimum wins ties.
      if (r.kind === "EVIDENCE" && r.impact < best) {
        best = r.impact;
        riskReasonIndex = i;
      }
    });
  }

  const pulseResult = results.RELATIONSHIP?.pulse;
  const pulse =
    pulseResult && pulseResult.score !== null
      ? {
          id: pulseResult.reason.sources[0]!.sourceId!,
          value:
            pulseResult.reason.pulseValue ??
            (pulseResult.score >= model.params.pulseScore.FINE ? "FINE" : "WORRIED"),
        }
      : null;
  const excl = pulse ? overallOf(pillarScores(results, model, "pulse"), model).overall : overall;
  const riskLevelExcludingPulse = band(excl, model, tier);
  const pulseDisagreement =
    pulse !== null &&
    ((pulse.value === "WORRIED" && riskLevelExcludingPulse === "HEALTHY") ||
      (pulse.value === "FINE" && riskLevelExcludingPulse === "AT_RISK"));

  return {
    overall: overall === null ? null : round2(overall),
    overallExcludingPulse: excl === null ? null : round2(excl),
    pillars: Object.fromEntries(
      PILLARS.map((p) => [p, scores[p].score === null ? null : round2(scores[p].score!)]),
    ) as Record<Pillar, number | null>,
    effectiveWeights: Object.fromEntries(
      PILLARS.map((p) => [
        p,
        scores[p].score === null || overall === null
          ? null
          : round4(model.pillarWeights[p] / total),
      ]),
    ) as Record<Pillar, number | null>,
    riskLevel,
    riskLevelExcludingPulse,
    riskReasonIndex,
    reasons,
    pulse,
    pulseDisagreement,
  };
}
