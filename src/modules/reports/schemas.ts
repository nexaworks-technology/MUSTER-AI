import { z } from "zod";
import { addDays, daysBetween, type CalendarDate } from "@/lib/dates";
import { TIERS } from "@/modules/accounts/schemas";
import { REPORT_KEYS } from "./types";

export const PERIOD_DAYS = [30, 90, 180, 365] as const;
export const DEFAULT_PERIOD_DAYS = 90;
const MAX_SPAN_DAYS = 366;

const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const optional = <T extends z.ZodType>(t: T) => z.preprocess(blankToUndefined, t.optional());

/**
 * Report filters (M11 S6): a period (a preset of days, or an explicit start and end), an owner
 * (a membership id, or "none" for unowned accounts), a tier and a saved segment. Everything is
 * optional and validated; book scope is never a filter, it comes from the viewer's permission.
 */
export const reportFilters = z
  .object({
    periodDays: optional(
      z.coerce
        .number()
        .int()
        .refine(
          (n): n is (typeof PERIOD_DAYS)[number] => (PERIOD_DAYS as readonly number[]).includes(n),
          {
            message: "Pick 30, 90, 180 or 365 days.",
          },
        ),
    ),
    start: optional(z.iso.date()),
    end: optional(z.iso.date()),
    owner: optional(z.string().min(1).max(64)),
    tier: optional(z.enum(TIERS)),
    segment: optional(z.string().min(1).max(64)),
  })
  .superRefine((f, ctx) => {
    const range = f.start !== undefined || f.end !== undefined;
    if (range && f.periodDays !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "Use a preset period or a start and end, not both.",
      });
    if (range && (f.start === undefined || f.end === undefined))
      ctx.addIssue({ code: "custom", message: "A custom period needs both a start and an end." });
    if (f.start && f.end) {
      if (f.start > f.end)
        ctx.addIssue({ code: "custom", message: "The start must not be after the end." });
      else if (daysBetween(f.start, f.end) > MAX_SPAN_DAYS)
        ctx.addIssue({ code: "custom", message: "A period can be at most a year." });
    }
  });

export type ReportFilters = z.infer<typeof reportFilters>;

/** Defaults filled in, keys in a fixed order, so equal filters are byte-equal when stored/hashed. */
export interface NormalizedFilters {
  periodDays?: number;
  start?: string;
  end?: string;
  owner?: string;
  tier?: (typeof TIERS)[number];
  segment?: string;
}

export function normalizeFilters(f: ReportFilters): NormalizedFilters {
  const custom = f.start !== undefined && f.end !== undefined;
  return {
    ...(custom
      ? { start: f.start, end: f.end }
      : { periodDays: f.periodDays ?? DEFAULT_PERIOD_DAYS }),
    ...(f.owner ? { owner: f.owner } : {}),
    ...(f.tier ? { tier: f.tier } : {}),
    ...(f.segment ? { segment: f.segment } : {}),
  };
}

/** The dates a filter set means on `today` (the workspace's business date). */
export function resolvePeriod(
  f: NormalizedFilters,
  today: CalendarDate,
): { start: CalendarDate; end: CalendarDate } {
  if (f.start && f.end) return { start: f.start, end: f.end };
  return { start: addDays(today, -(f.periodDays ?? DEFAULT_PERIOD_DAYS)), end: today };
}

export const reportKeySchema = z.enum(REPORT_KEYS);

/** The Generate button's input: a report key plus the filter fields as they came from the form. */
export const generateInput = z.object({ reportKey: reportKeySchema, filters: reportFilters });
