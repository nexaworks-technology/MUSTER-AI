import type { Prisma } from "@prisma/client";
import { z } from "zod";

/**
 * Segment filter language (spec §6F5, DECISIONS D-45): an AND of typed conditions over a
 * whitelist of Account fields. Unknown fields or operators fail validation. The compiled `where`
 * is always applied through scopedDb and the member's book, so it can never reach another
 * workspace. Health filters arrive in M3.
 */
const TIERS = ["HIGH_TOUCH", "MID_TOUCH", "LONG_TAIL"] as const;
const STAGES = ["ONBOARDING", "ADOPTING", "MATURE", "RENEWING", "LOST"] as const;
const TEXT_FIELDS = [
  "name",
  "domain",
  "plan",
  "industry",
  "employeeBand",
  "useCase",
  "timezone",
] as const;
const DATE_FIELDS = [
  "renewalDate",
  "lastTouchAt",
  "onboardingStartedAt",
  "churnedAt",
  "createdAt",
] as const;

const text = z.string().trim().min(1).max(120);
const date = z.coerce.date();
const days = z.number().int().min(1).max(3650);
const money = z.number().nonnegative().max(1e12);

const textCondition = z.discriminatedUnion("op", [
  z.object({ field: z.enum(TEXT_FIELDS), op: z.literal("eq"), value: text }),
  z.object({
    field: z.enum(TEXT_FIELDS),
    op: z.literal("in"),
    value: z.array(text).min(1).max(50),
  }),
  z.object({ field: z.enum(TEXT_FIELDS), op: z.literal("contains"), value: text }),
  z.object({ field: z.enum(TEXT_FIELDS), op: z.literal("isEmpty") }),
]);

const enumCondition = <F extends string, V extends readonly [string, ...string[]]>(
  field: F,
  values: V,
) =>
  z.discriminatedUnion("op", [
    z.object({ field: z.literal(field), op: z.literal("eq"), value: z.enum(values) }),
    z.object({
      field: z.literal(field),
      op: z.literal("in"),
      value: z.array(z.enum(values)).min(1),
    }),
  ]);

const dateCondition = z.discriminatedUnion("op", [
  z.object({ field: z.enum(DATE_FIELDS), op: z.literal("before"), value: date }),
  z.object({ field: z.enum(DATE_FIELDS), op: z.literal("after"), value: date }),
  z.object({ field: z.enum(DATE_FIELDS), op: z.literal("between"), value: z.tuple([date, date]) }),
  z.object({ field: z.enum(DATE_FIELDS), op: z.literal("withinNextDays"), value: days }),
  z.object({ field: z.enum(DATE_FIELDS), op: z.literal("olderThanDays"), value: days }),
  z.object({ field: z.enum(DATE_FIELDS), op: z.literal("isEmpty") }),
]);

/** ARR in whole units of the base currency. */
const arrCondition = z.discriminatedUnion("op", [
  z.object({ field: z.literal("arr"), op: z.literal("gte"), value: money }),
  z.object({ field: z.literal("arr"), op: z.literal("lte"), value: money }),
  z.object({ field: z.literal("arr"), op: z.literal("between"), value: z.tuple([money, money]) }),
  z.object({ field: z.literal("arr"), op: z.literal("isEmpty") }),
]);

const ownerCondition = z.object({
  field: z.literal("owner"),
  op: z.literal("eq"),
  value: z.string().min(1).max(64),
});

export const segmentCondition = z.union([
  textCondition,
  enumCondition("tier", TIERS),
  enumCondition("lifecycleStage", STAGES),
  enumCondition("tierSource", ["RULE", "MANUAL"] as const),
  // M3 (D-45): the account's current health band.
  enumCondition("health", ["HEALTHY", "WATCH", "AT_RISK", "INSUFFICIENT_DATA"] as const),
  dateCondition,
  arrCondition,
  ownerCondition,
]);

export const segmentFilter = z.object({ all: z.array(segmentCondition).min(1).max(20) });

export type SegmentFilter = z.infer<typeof segmentFilter>;
export type SegmentCondition = z.infer<typeof segmentCondition>;

export interface CompileContext {
  now: Date;
  /** Minor units per whole unit of the base currency (e.g. 100n for USD). */
  arrScale: bigint;
  canViewRevenue: boolean;
}

export class SegmentPermissionError extends Error {
  constructor() {
    super("Filtering by ARR needs revenue access");
    this.name = "SegmentPermissionError";
  }
}

const DAY = 86_400_000;

function compileCondition(c: SegmentCondition, ctx: CompileContext): Prisma.AccountWhereInput {
  switch (c.field) {
    case "arr": {
      if (!ctx.canViewRevenue) throw new SegmentPermissionError();
      const minor = (v: number) => BigInt(Math.round(v)) * ctx.arrScale;
      if (c.op === "gte") return { arrMinor: { gte: minor(c.value) } };
      if (c.op === "lte") return { arrMinor: { lte: minor(c.value) } };
      if (c.op === "between")
        return { arrMinor: { gte: minor(c.value[0]), lte: minor(c.value[1]) } };
      return { arrMinor: null };
    }
    case "owner":
      return { ownerMembershipId: c.value === "none" ? null : c.value };
    case "health":
      return {
        currentHealth: {
          is: { riskLevel: c.op === "eq" ? c.value : { in: c.value } },
        },
      };
    case "tier":
    case "lifecycleStage":
    case "tierSource":
      return c.op === "eq" ? { [c.field]: c.value } : { [c.field]: { in: c.value } };
    case "renewalDate":
    case "lastTouchAt":
    case "onboardingStartedAt":
    case "churnedAt":
    case "createdAt":
      switch (c.op) {
        case "before":
          return { [c.field]: { lt: c.value } };
        case "after":
          return { [c.field]: { gt: c.value } };
        case "between":
          return { [c.field]: { gte: c.value[0], lte: c.value[1] } };
        case "withinNextDays":
          return { [c.field]: { gte: ctx.now, lte: new Date(ctx.now.getTime() + c.value * DAY) } };
        case "olderThanDays":
          return { [c.field]: { lt: new Date(ctx.now.getTime() - c.value * DAY) } };
        case "isEmpty":
          return { [c.field]: null };
      }
      break;
    default:
      switch (c.op) {
        case "eq":
          return { [c.field]: { equals: c.value, mode: "insensitive" } };
        case "in":
          return { [c.field]: { in: c.value } };
        case "contains":
          return { [c.field]: { contains: c.value, mode: "insensitive" } };
        case "isEmpty":
          return { [c.field]: null };
      }
  }
  throw new Error("Unsupported segment condition");
}

export function compileSegment(
  filter: SegmentFilter,
  ctx: CompileContext,
): Prisma.AccountWhereInput {
  return { AND: filter.all.map((c) => compileCondition(c, ctx)) };
}
