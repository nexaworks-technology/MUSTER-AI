import { utcMidnight, type CalendarDate } from "@/lib/dates";
import type { Tier } from "./types";

/** Deterministic wording helpers for reason templates (no locale surprises: en-US, UTC days). */
const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const monthDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export const day = (d: CalendarDate) => dateFmt.format(utcMidnight(d));

export function period(from: CalendarDate, to: CalendarDate): string {
  return from.slice(0, 4) === to.slice(0, 4)
    ? `${monthDay.format(utcMidnight(from))} – ${day(to)}`
    : `${day(from)} – ${day(to)}`;
}

/** At most one decimal, none when whole. */
export const num = (x: number) => String(Math.round(x * 10) / 10);
export const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;
export function signedPct(change: number): string {
  const p = Math.round(change * 100);
  return p < 0 ? `−${Math.abs(p)}%` : `+${p}%`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const TIER_WORDS: Record<Tier, string> = {
  HIGH_TOUCH: "High-touch",
  MID_TOUCH: "Mid-touch",
  LONG_TAIL: "Long-tail",
};

/** Rounded for storage and display (4 decimals keeps ratios exact enough to re-derive). */
export const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
