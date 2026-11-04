import { z } from "zod";

/**
 * Renewal confidence settings (M7 D10). Every default is a documented starting point, editable
 * as an audited workspace setting; none is tuned to a seed number (D-59). Weights are points added
 * to or taken from `base`; the result is clamped to 0–100.
 *
 * The shipped defaults are the SIMPLE model (D-118): the health band and the notice deadline
 * count, and every other factor is still computed, listed with its reason and sources, and given
 * zero points. The back-test (backtest.ts) measured the full factor model (`FACTOR_MODEL`) against
 * it on the seeded history and the simple one calibrated better, so it ships; a workspace whose
 * own history supports more can turn weights on here.
 */
const points = z.number().min(-100).max(100);

export const confidenceConfig = z.object({
  /** Where a renewal starts before any record moves it: "likely unless the records say otherwise". */
  base: z.number().min(0).max(100).default(70),
  healthBand: z
    .object({
      HEALTHY: points.default(10),
      WATCH: points.default(-10),
      AT_RISK: points.default(-30),
    })
    .prefault({}),
  healthTrend: z
    .object({
      /** Overall health points gained or lost over the last 30 days. */
      fallingBy10: points.default(0),
      fallingBy5: points.default(0),
      risingBy5: points.default(0),
    })
    .prefault({}),
  signals: z
    .object({
      criticalEach: points.default(0),
      warnEach: points.default(0),
      /** The most open risk signals can take off, however many there are. */
      maxPenalty: points.default(0),
    })
    .prefault({}),
  champion: z
    .object({
      active: points.default(0),
      silent: points.default(0),
      gone: points.default(0),
      silentAfterDays: z.number().int().min(7).max(365).default(30),
    })
    .prefault({}),
  invoices: z
    .object({
      failedUnpaid: points.default(0),
      lateUnpaid: points.default(0),
      paidLate: points.default(0),
      clean: points.default(0),
      /** Days past due that make an unpaid invoice late, and a paid one "paid late". */
      lateAfterDays: z.number().int().min(1).max(90).default(7),
      paidLateAfterDays: z.number().int().min(1).max(90).default(14),
      lookbackDays: z.number().int().min(30).max(730).default(180),
    })
    .prefault({}),
  notice: z
    .object({
      /** A notice deadline this close (or passed) with no renewal plan. */
      noPlanWithinDays: z.number().int().min(1).max(120).default(14),
      noPlan: points.default(-10),
      hasPlan: points.default(5),
    })
    .prefault({}),
  usage: z
    .object({
      atLeast90: points.default(0),
      atLeast70: points.default(0),
      atLeast50: points.default(0),
      below50: points.default(0),
    })
    .prefault({}),
  bands: z
    .object({
      highAtLeast: z.number().int().min(1).max(100).default(70),
      mediumAtLeast: z.number().int().min(0).max(99).default(40),
    })
    .refine((b) => b.mediumAtLeast < b.highAtLeast, {
      message: "The medium line must be below the high line",
    })
    .prefault({}),
});

export type ConfidenceConfig = z.infer<typeof confidenceConfig>;

/** The default configuration (what an empty settings row means): the simple model. */
export const DEFAULT_CONFIDENCE: ConfidenceConfig = confidenceConfig.parse({});

/**
 * The full factor model: every factor weighted. Not the default (it lost the back-test, D-118),
 * kept as the comparison the back-test runs and as an opt-in preset.
 */
export const FACTOR_MODEL: ConfidenceConfig = confidenceConfig.parse({
  healthTrend: { fallingBy10: -8, fallingBy5: -4, risingBy5: 4 },
  signals: { criticalEach: -12, warnEach: -6, maxPenalty: -30 },
  champion: { active: 5, silent: -15, gone: -25 },
  invoices: { failedUnpaid: -15, lateUnpaid: -10, paidLate: -5, clean: 5 },
  usage: { atLeast90: 5, atLeast70: 0, atLeast50: -10, below50: -20 },
});

/** The settings section: `WorkspaceSettings.data.renewals`. */
export const renewalSettings = z
  .object({
    confidence: confidenceConfig.prefault({}),
    /** A renewal this far out is on the radar (months of lead). */
    horizonDays: z.number().int().min(30).max(730).default(365),
  })
  .prefault({});

export const FORECAST_CATEGORIES = ["COMMIT", "BEST_CASE", "AT_RISK", "OMITTED"] as const;
export const CATEGORY_WORDS: Record<(typeof FORECAST_CATEGORIES)[number], string> = {
  COMMIT: "Commit",
  BEST_CASE: "Best case",
  AT_RISK: "At risk",
  OMITTED: "Omitted",
};
