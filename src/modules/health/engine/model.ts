import { z } from "zod";
import { curveSchema, type Curve } from "./curves";

/**
 * A health model's full, reproducible configuration (ARCHITECTURE §4.1, §4.5). Stored on
 * HealthModel and Zod-checked on every read and write. The defaults below are the formulas the
 * founder approved for M3 (see docs/DECISIONS.md D-63).
 */
export const PILLARS = [
  "ADOPTION",
  "ENGAGEMENT",
  "SUPPORT",
  "RELATIONSHIP",
  "COMMERCIAL",
  "SENTIMENT",
] as const;
export type Pillar = (typeof PILLARS)[number];

export const PILLAR_LABELS: Record<Pillar, string> = {
  ADOPTION: "Adoption",
  ENGAGEMENT: "Engagement",
  SUPPORT: "Support",
  RELATIONSHIP: "Relationship",
  COMMERCIAL: "Commercial",
  SENTIMENT: "Sentiment",
};

const component = z.object({ weight: z.number().min(0), curve: curveSchema.optional() });
export type ComponentConfig = z.infer<typeof component>;

const c = (weight: number, curve?: Curve): ComponentConfig => ({ weight, curve });

export const DEFAULT_COMPONENT_CONFIG = {
  ADOPTION: {
    active_vs_own: c(35, [
      [0.2, 0],
      [0.5, 40],
      [0.8, 75],
      [1, 100],
    ]),
    active_rate_vs_cohort: c(25, [
      [0.1, 0],
      [0.4, 35],
      [0.7, 70],
      [1, 100],
    ]),
    seat_use: c(15, [
      [0.05, 0],
      [0.2, 20],
      [0.4, 50],
      [0.6, 80],
      [0.8, 100],
    ]),
    key_features: c(15, [
      [0, 0],
      [0.25, 15],
      [0.5, 45],
      [0.75, 75],
      [1, 100],
    ]),
    power_users: c(10, [
      [0.25, 0],
      [0.5, 40],
      [0.75, 70],
      [1, 100],
    ]),
  },
  ENGAGEMENT: {
    last_customer_reply: c(35, [
      [14, 100],
      [30, 75],
      [45, 50],
      [60, 25],
      [90, 0],
    ]),
    last_meeting: c(20),
    reply_rate: c(25, [
      [0, 0],
      [0.2, 40],
      [0.4, 75],
      [0.6, 100],
    ]),
    champion_activity: c(20),
  },
  SUPPORT: {
    open_high: c(35, [
      [0, 100],
      [1, 60],
      [2, 30],
      [3, 0],
    ]),
    oldest_open_vs_target: c(30, [
      [1, 100],
      [2, 60],
      [4, 20],
      [6, 0],
    ]),
    escalations_30d: c(35, [
      [0, 100],
      [1, 50],
      [2, 10],
    ]),
    repeat_problem: c(0),
    ticket_sentiment: c(0),
  },
  RELATIONSHIP: {
    champion_present: c(30),
    decision_maker: c(15),
    breadth: c(15, [
      [0, 0],
      [0.5, 50],
      [1, 100],
    ]),
    champion_change_90d: c(10),
    nps_decision_makers: c(0),
    pulse: c(30),
  },
  COMMERCIAL: {
    invoices_90d: c(40),
    seat_trend: c(20, [
      [0.4, 0],
      [0.6, 40],
      [0.8, 70],
      [1, 100],
    ]),
    contraction_12m: c(20),
    renewal_plan: c(0),
  },
  SENTIMENT: {
    sentiment_share: c(50),
    survey_average: c(50),
  },
} satisfies Record<Pillar, Record<string, ComponentConfig>>;

/** Fixed parameters of the M3 formulas (part of the model so a version reproduces exactly). */
export const DEFAULT_PARAMS = {
  /** Target days to resolve an open ticket, by priority. */
  ticketTargetDays: { URGENT: 2, HIGH: 5, NORMAL: 10, LOW: 20 },
  /** People with a role we expect to know, by tier. */
  expectedContacts: { HIGH_TOUCH: 4, MID_TOUCH: 3, LONG_TAIL: 1 },
  pulseScore: { FINE: 100, WORRIED: 20 },
  pulseValidDays: 30,
  invoiceGraceDays: 7,
  championQuietMinDays: 21,
  championQuietCadences: 3,
  usageStaleDays: 3,
  ownBaselineMinDays: 28,
  cohortMinPeers: 5,
};

export type ModelParams = typeof DEFAULT_PARAMS;

export const DEFAULT_PILLAR_WEIGHTS: Record<Pillar, number> = {
  ADOPTION: 0.3,
  ENGAGEMENT: 0.15,
  SUPPORT: 0.15,
  RELATIONSHIP: 0.2,
  COMMERCIAL: 0.1,
  SENTIMENT: 0.1,
};

export const DEFAULT_THRESHOLDS = { healthyMin: 70, watchMin: 45 };

const thresholds = z
  .object({ healthyMin: z.number().min(0).max(100), watchMin: z.number().min(0).max(100) })
  .refine((t) => t.watchMin < t.healthyMin, { message: "Watch must start below Healthy" });

export const pillarWeightsSchema = z
  .object(
    Object.fromEntries(PILLARS.map((p) => [p, z.number().min(0).max(1)])) as {
      [K in Pillar]: z.ZodNumber;
    },
  )
  .refine((w) => Math.abs(PILLARS.reduce((s, p) => s + w[p], 0) - 1) < 1e-9, {
    message: "Pillar weights must add up to 100%",
  });

export const modelConfigSchema = z.object({
  pillarWeights: pillarWeightsSchema,
  componentConfig: z.record(z.string(), z.record(z.string(), component)),
  params: z.custom<typeof DEFAULT_PARAMS>((v) => typeof v === "object" && v !== null),
  thresholds,
  perTierOverrides: z
    .object({
      HIGH_TOUCH: thresholds.optional(),
      MID_TOUCH: thresholds.optional(),
      LONG_TAIL: thresholds.optional(),
    })
    .prefault({}),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

export const DEFAULT_MODEL: ModelConfig = {
  pillarWeights: DEFAULT_PILLAR_WEIGHTS,
  componentConfig: DEFAULT_COMPONENT_CONFIG,
  params: DEFAULT_PARAMS,
  thresholds: DEFAULT_THRESHOLDS,
  perTierOverrides: {},
};
