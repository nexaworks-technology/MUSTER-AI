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

// ─── Outside signals (spec §6D, INTERP-6) ────────────────────────────────────

export const OUTSIDE_KINDS = [
  "FUNDING",
  "HIRING",
  "LEADERSHIP_CHANGE",
  "ACQUISITION",
  "LAYOFFS",
  "OTHER",
] as const;
export type OutsideKind = (typeof OUTSIDE_KINDS)[number];
export const OUTSIDE_KIND_WORDS: Record<OutsideKind, string> = {
  FUNDING: "Funding",
  HIRING: "Hiring",
  LEADERSHIP_CHANGE: "Leadership change",
  ACQUISITION: "Acquisition",
  LAYOFFS: "Layoffs",
  OTHER: "News",
};
/** Growth news is an opportunity; the rest is a risk to look at. */
export const OUTSIDE_POLARITY: Record<OutsideKind, "RISK" | "OPPORTUNITY"> = {
  FUNDING: "OPPORTUNITY",
  HIRING: "OPPORTUNITY",
  LEADERSHIP_CHANGE: "RISK",
  ACQUISITION: "RISK",
  LAYOFFS: "RISK",
  OTHER: "RISK",
};

const dayFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/** "New · Oct 20, 2026" within `newWithinDays` of the event, else "Reported Aug 14, 2026" — never fresh when old. */
export function outsideLabel(eventDate: string, today: string, newWithinDays: number): string {
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${eventDate}T00:00:00Z`)) / 86_400_000,
  );
  const shown = dayFmt.format(new Date(`${eventDate}T00:00:00Z`));
  return days <= newWithinDays ? `New · ${shown}` : `Reported ${shown}`;
}
