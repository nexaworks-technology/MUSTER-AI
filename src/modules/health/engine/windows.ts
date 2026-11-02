import { addDays, daysBetween, type CalendarDate } from "@/lib/dates";
import type { AccountBundle } from "./types";

/**
 * Shared usage windows. Usage windows end at the last complete day (yesterday) or, if the data
 * stops earlier but within `staleDays`, at the last day with data (M3 rule 3 / plan).
 */
export type Usage = NonNullable<AccountBundle["usage"]>;

export function usageUpTo(b: AccountBundle): Usage {
  return (b.usage ?? []).filter((u) => u.date <= b.asOf).sort((x, y) => (x.date < y.date ? -1 : 1));
}

export type CurrentWindow =
  | { ok: true; from: CalendarDate; to: CalendarDate; value: number }
  | { ok: false; reason: "none" | "stale"; lastDate?: CalendarDate };

/** "Typical weekday active users": the average of the 5 busiest days in the 7-day window. */
export function typicalWeekday(rows: Usage, to: CalendarDate): number {
  const from = addDays(to, -6);
  const byDate = new Map(rows.map((r) => [r.date, r.activeUsers]));
  const values = Array.from({ length: 7 }, (_, i) => byDate.get(addDays(from, i)) ?? 0);
  const top = values.sort((a, b) => b - a).slice(0, 5);
  return top.reduce((s, v) => s + v, 0) / 5;
}

export function currentUsage(b: AccountBundle, staleDays: number): CurrentWindow {
  if (b.usage === null) return { ok: false, reason: "none" };
  const rows = usageUpTo(b);
  const yesterday = addDays(b.asOf, -1);
  const last = rows.filter((r) => r.date <= yesterday).at(-1);
  if (!last) return { ok: false, reason: "none" };
  if (daysBetween(last.date, yesterday) > staleDays)
    return { ok: false, reason: "stale", lastDate: last.date };
  return {
    ok: true,
    from: addDays(last.date, -6),
    to: last.date,
    value: typicalWeekday(rows, last.date),
  };
}

export const inRange = (d: CalendarDate, from: CalendarDate, to: CalendarDate) =>
  d >= from && d <= to;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length / 2;
  return s.length % 2 ? s[Math.floor(m)]! : (s[m - 1]! + s[m]!) / 2;
}
