import { z } from "zod";

/**
 * Renewal confidence settings (M7 D10). Every default is a documented starting point, editable
 * as an audited workspace setting; none is tuned to a seed number (D-59). The factor model's
 * weights are in points added to or taken from `base`; the result is clamped to 0–100.
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
      fallingBy10: points.default(-8),
      fallingBy5: points.default(-4),
      risingBy5: points.default(4),
    })
    .prefault({}),
  signals: z
    .object({
      criticalEach: points.default(-12),
      warnEach: points.default(-6),
      /** The most open risk signals can take off, however many there are. */
      maxPenalty: points.default(-30),
    })
    .prefault({}),
  champion: z
    .object({
      active: points.default(5),
      silent: points.default(-15),
      gone: points.default(-25),
      silentAfterDays: z.number().int().min(7).max(365).default(30),
    })
    .prefault({}),
  invoices: z
    .object({
      failedUnpaid: points.default(-15),
      lateUnpaid: points.default(-10),
      paidLate: points.default(-5),
      clean: points.default(5),
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
      atLeast90: points.default(5),
      atLeast70: points.default(0),
      atLeast50: points.default(-10),
      below50: points.default(-20),
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

/** The default configuration (what an empty settings row means). */
export const DEFAULT_CONFIDENCE: ConfidenceConfig = confidenceConfig.parse({});

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
