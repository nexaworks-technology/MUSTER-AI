import { z } from "zod";

export const PLAY_TIERS = ["HIGH_TOUCH", "MID_TOUCH", "LONG_TAIL"] as const;
export type PlayTier = (typeof PLAY_TIERS)[number];

export const PLAY_HANDLERS = [
  "notify",
  "task",
  "draft",
  "send",
  "update",
  "escalate",
  "wait",
  "exit",
] as const;
export type PlayHandler = (typeof PLAY_HANDLERS)[number];

export const APPROVAL_LEVELS = [
  "NOTIFY_ONLY",
  "DRAFT_FOR_APPROVAL",
  "DRAFT_IN_MAILBOX",
  "DO_AUTOMATICALLY",
  "SEND_AUTOMATICALLY",
] as const;
export type PlayApprovalLevel = (typeof APPROVAL_LEVELS)[number];

export const playTriggerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("signal"),
    ruleKey: z.string().min(1),
  }),
  z.object({
    type: z.literal("event"),
    eventType: z.string().min(1),
  }),
  z.object({
    type: z.literal("schedule"),
    cron: z.string().min(1),
  }),
  z.object({
    type: z.literal("segmentEntry"),
    segmentId: z.string().min(1),
  }),
  z.object({
    type: z.literal("noteTag"),
    tag: z.string().min(1),
  }),
]);
export type PlayTrigger = z.infer<typeof playTriggerSchema>;

export const playConditionSchema = z.object({
  field: z.string().min(1),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains", "isEmpty", "isNotEmpty"]),
  value: z.unknown().optional(),
});
export type PlayCondition = z.infer<typeof playConditionSchema>;

export const playStepDefinitionSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  handler: z.enum(PLAY_HANDLERS),
  params: z.record(z.unknown()).default({}),
  approvalLevelByTier: z.object({
    HIGH_TOUCH: z.enum(APPROVAL_LEVELS),
    MID_TOUCH: z.enum(APPROVAL_LEVELS),
    LONG_TAIL: z.enum(APPROVAL_LEVELS),
  }),
  safe: z.boolean().default(false),
  sensitive: z.boolean().default(false),
});
export type PlayStepDefinition = z.infer<typeof playStepDefinitionSchema>;

export const playBranchSchema = z.object({
  tier: z.enum(PLAY_TIERS).optional(),
  healthBand: z.enum(["HEALTHY", "WATCH", "AT_RISK"]).optional(),
  arrMinMinor: z.union([z.bigint(), z.number()]).optional(),
  arrMaxMinor: z.union([z.bigint(), z.number()]).optional(),
  renewalWindowDays: z.number().int().positive().optional(),
  steps: z.array(playStepDefinitionSchema).default([]),
});
export type PlayBranch = z.infer<typeof playBranchSchema>;

export const playDefinitionSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  category: z.string().default("general"),
  segmentId: z.string().optional(),
  trigger: playTriggerSchema,
  conditions: z.array(playConditionSchema).default([]),
  branches: z.array(playBranchSchema).default([]),
  steps: z.array(playStepDefinitionSchema).default([]),
  exitConditions: z.array(playConditionSchema).default([]),
});
export type PlayDefinition = z.infer<typeof playDefinitionSchema>;
