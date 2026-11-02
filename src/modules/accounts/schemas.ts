import { z } from "zod";

export const TIER_LABELS = {
  HIGH_TOUCH: "High-touch",
  MID_TOUCH: "Mid-touch",
  LONG_TAIL: "Long-tail",
} as const;
export const STAGE_LABELS = {
  ONBOARDING: "Onboarding",
  ADOPTING: "Adopting",
  MATURE: "Mature",
  RENEWING: "Renewing",
  LOST: "Lost",
} as const;

export const TIERS = ["HIGH_TOUCH", "MID_TOUCH", "LONG_TAIL"] as const;
export const STAGES = ["ONBOARDING", "ADOPTING", "MATURE", "RENEWING", "LOST"] as const;
export const SORTS = ["name", "arr", "renewal", "lastTouch"] as const;
export const PAGE_SIZE = 50;

const emptyToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(emptyToUndefined, z.enum(values).optional());

/** Accounts list query from URL search params; everything optional, everything validated. */
export const accountListQuery = z.object({
  q: z.preprocess(emptyToUndefined, z.string().trim().max(120).optional()),
  tier: optionalEnum(TIERS),
  stage: optionalEnum(STAGES),
  /** A membership id, or "none" for unowned accounts. */
  owner: z.preprocess(emptyToUndefined, z.string().max(64).optional()),
  segment: z.preprocess(emptyToUndefined, z.string().max(64).optional()),
  sort: z.preprocess(emptyToUndefined, z.enum(SORTS).default("name")),
  dir: z.preprocess(emptyToUndefined, z.enum(["asc", "desc"]).default("asc")),
  cursor: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{1,6}$/)
      .optional(),
  ),
});

export type AccountListQuery = z.infer<typeof accountListQuery>;

// ─── Timeline (shared by every module that contributes timeline items) ───────

export type TimelineKind =
  | "email"
  | "call"
  | "ticket"
  | "invoice"
  | "usage"
  | "note"
  | "task"
  | "people"
  | "contract"
  | "revenue";

export interface TimelineItem {
  /** Unique across sources: `<source>:<id>[:<event>]`. Also the tie-breaker. */
  key: string;
  at: Date;
  kind: TimelineKind;
  title: string;
  detail?: string;
  href?: string;
  sourceType: string;
  sourceId: string;
}

export { decodeCursor, encodeCursor, mergeTimeline } from "./timeline";

/** Inline edit: any subset of owner / tier / stage. tier "RULE" hands the tier back to the ARR rule. */
export const accountPatch = z
  .object({
    ownerMembershipId: z.preprocess(
      (v) => (v === "none" ? null : v),
      z.string().min(1).nullable().optional(),
    ),
    tier: z.enum(["HIGH_TOUCH", "MID_TOUCH", "LONG_TAIL", "RULE"]).optional(),
    lifecycleStage: z.enum(STAGES).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "Nothing to change");

export { QUESTIONS as MISSING_DATA_QUESTIONS, type MissingField } from "./missing-data";
