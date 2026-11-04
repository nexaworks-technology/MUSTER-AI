/**
 * How well a renewal likelihood matched what happened (M7 rule 2). Pure arithmetic over
 * (likelihood, outcome) pairs. The positive class is "renewed". Nothing here is tuned to a target:
 * the numbers are reported as they come out.
 *
 * - calibration by band and by score bucket: of the accounts scored in it, how many renewed;
 * - Brier score: mean of (likelihood/100 − outcome)², 0 is perfect, 0.25 is "always 50%";
 * - AUC: the chance a renewed account was scored above a churned one (ties count half), so 0.5
 *   is no better than a coin and 1 is perfect separation.
 */
export interface Sample {
  confidence: number;
  band: "HIGH" | "MEDIUM" | "LOW";
  renewed: boolean;
}

export interface Bucket {
  label: string;
  n: number;
  renewed: number;
  churned: number;
  /** Share that renewed, or null for an empty bucket (never shown as 0%). */
  renewedShare: number | null;
}

export interface Calibration {
  n: number;
  renewed: number;
  churned: number;
  byBand: Bucket[];
  byScore: Bucket[];
  brier: number | null;
  auc: number | null;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

function bucket(label: string, rows: Sample[]): Bucket {
  const renewed = rows.filter((r) => r.renewed).length;
  return {
    label,
    n: rows.length,
    renewed,
    churned: rows.length - renewed,
    renewedShare: rows.length ? round4(renewed / rows.length) : null,
  };
}

export const SCORE_BUCKETS = [
  { label: "80–100", min: 80, max: 100 },
  { label: "60–79", min: 60, max: 79 },
  { label: "40–59", min: 40, max: 59 },
  { label: "0–39", min: 0, max: 39 },
] as const;

export function calibrate(samples: Sample[]): Calibration {
  const renewed = samples.filter((s) => s.renewed);
  const churned = samples.filter((s) => !s.renewed);
  let auc: number | null = null;
  if (renewed.length && churned.length) {
    let wins = 0;
    for (const r of renewed)
      for (const c of churned)
        wins += r.confidence > c.confidence ? 1 : r.confidence === c.confidence ? 0.5 : 0;
    auc = round4(wins / (renewed.length * churned.length));
  }
  return {
    n: samples.length,
    renewed: renewed.length,
    churned: churned.length,
    byBand: (["HIGH", "MEDIUM", "LOW"] as const).map((b) =>
      bucket(
        b,
        samples.filter((s) => s.band === b),
      ),
    ),
    byScore: SCORE_BUCKETS.map((b) =>
      bucket(
        b.label,
        samples.filter((s) => s.confidence >= b.min && s.confidence <= b.max),
      ),
    ),
    brier: samples.length
      ? round4(
          samples.reduce((sum, s) => sum + (s.confidence / 100 - (s.renewed ? 1 : 0)) ** 2, 0) /
            samples.length,
        )
      : null,
    auc,
  };
}

/**
 * The shipping rule, fixed before the first measurement (D-118): the model with the lower pooled
 * Brier score ships; if the factor model does not beat the simple one by more than this margin,
 * the simple one ships (a clever model has to earn its complexity).
 */
export const BRIER_MARGIN = 0.005;

export function chooseModel(
  factorBrier: number | null,
  simpleBrier: number | null,
): "factor" | "simple" {
  if (factorBrier === null || simpleBrier === null) return "simple";
  return factorBrier < simpleBrier - BRIER_MARGIN ? "factor" : "simple";
}
