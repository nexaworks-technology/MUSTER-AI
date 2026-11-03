import { z } from "zod";

/**
 * Onboarding template contents (spec §6G1, D1, D3). A condition is a statement about metrics the
 * product already measures (daily usage, feature usage, seats); nothing else can complete a step
 * or mark value reached. Each condition reads in plain words through `describeCondition`.
 */
const featureKey = z.string().trim().min(1).max(100);

export const condition = z.discriminatedUnion("metric", [
  z.object({
    metric: z.literal("featureUsed"),
    featureKey,
    /** On at least this many distinct days since the plan started. */
    minDays: z.number().int().min(1).max(90).default(1),
  }),
  z.object({
    metric: z.literal("keyFeaturesUsed"),
    /** At least this many different key features of the account's plan used since the start. */
    min: z.number().int().min(1).max(50),
  }),
  z.object({
    metric: z.literal("activeUsers"),
    min: z.number().int().min(1).max(100_000),
    /** On each of this many weekdays in a row (weekends skipped: B2B use drops then). */
    days: z.number().int().min(1).max(60).default(1),
  }),
  z.object({
    metric: z.literal("activeSeatShare"),
    /** Active users ÷ seats bought, 0–1. */
    min: z.number().min(0.01).max(1),
    days: z.number().int().min(1).max(60).default(1),
  }),
]);
export type Condition = z.infer<typeof condition>;

export const valueDefinition = z.array(condition).max(10);

export const templateStep = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,40}$/, "Use lowercase letters, digits and underscores"),
  title: z.string().trim().min(1).max(120),
  ownerSide: z.enum(["US", "CUSTOMER"]),
  /** Due this many days after the plan starts. */
  dueDay: z.number().int().min(0).max(365),
  /** Optional: a product event that completes this step by itself (D1). */
  completesWhen: condition.optional(),
});
export type TemplateStep = z.infer<typeof templateStep>;

export const templateInput = z
  .object({
    name: z.string().trim().min(1, "Name the template").max(80),
    forTier: z.enum(["HIGH_TOUCH", "MID_TOUCH", "LONG_TAIL"]).nullable().default(null),
    forPlan: z.string().trim().max(60).nullable().default(null),
    targetDays: z.number().int().min(1).max(365),
    steps: z.array(templateStep).min(1, "Add at least one step").max(40),
    valueDefinition,
  })
  .refine((t) => new Set(t.steps.map((s) => s.key)).size === t.steps.length, {
    message: "Each step needs its own key",
  });
export type TemplateInput = z.input<typeof templateInput>;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const times = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function describeCondition(c: Condition, labels: Record<string, string> = {}): string {
  switch (c.metric) {
    case "featureUsed":
      return `${labels[c.featureKey] ?? c.featureKey} used on ${times(c.minDays, "day", "different days")}`;
    case "keyFeaturesUsed":
      return `${times(c.min, "key feature", "key features")} of the plan used`;
    case "activeUsers":
      return `at least ${times(c.min, "active user", "active users")}${c.days > 1 ? ` on each of ${c.days} weekdays in a row` : ""}`;
    case "activeSeatShare":
      return `at least ${pct(c.min)} of seats active${c.days > 1 ? ` on each of ${c.days} weekdays in a row` : ""}`;
  }
}
