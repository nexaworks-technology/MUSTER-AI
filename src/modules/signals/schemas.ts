import { z } from "zod";

/** Signals portfolio list query (URL search params; everything optional, everything validated). */
const empty = (v: unknown) => (v === "" ? undefined : v);
const opt = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(empty, z.enum(values).optional());

export const SIGNAL_STATUS_FILTERS = [
  "LIVE",
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
  "FALSE_ALARM",
  "ALL",
] as const;
export const SEVERITIES = ["CRITICAL", "WARN", "INFO"] as const;
export const CATEGORIES = ["USAGE", "PEOPLE", "SUPPORT", "MONEY", "OUTSIDE"] as const;

export const signalListQuery = z.object({
  status: opt(SIGNAL_STATUS_FILTERS),
  severity: opt(SEVERITIES),
  category: opt(CATEGORIES),
  cursor: z.preprocess(empty, z.coerce.number().int().min(0).optional()),
});
export type SignalListQuery = z.infer<typeof signalListQuery>;

export const SEVERITY_WORDS = { CRITICAL: "Critical", WARN: "Warning", INFO: "Info" } as const;
export const STATUS_WORDS = {
  OPEN: "Open",
  ACKNOWLEDGED: "Acknowledged",
  RESOLVED: "Resolved",
  FALSE_ALARM: "Marked false alarm",
} as const;
export const CATEGORY_WORDS = {
  USAGE: "Usage",
  PEOPLE: "People",
  SUPPORT: "Support",
  CALLS_EMAIL: "Calls & email",
  MONEY: "Money",
  PROMISES: "Promises",
  OUTSIDE: "Outside",
} as const;
