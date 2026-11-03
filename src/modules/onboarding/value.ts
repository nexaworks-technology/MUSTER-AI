import { addDays, type CalendarDate } from "@/lib/dates";
import type { Condition } from "./schemas";
import type { Source } from "./ttv";

/**
 * When did a condition first hold? (D1, D3), pure. Steps complete and value is reached only on a
 * business date where the measured rows say so; the proving rows are returned as evidence. A
 * condition that cannot be measured (no seats on file, no usage rows) is never met: missing data
 * never completes anything (Rule 4).
 */
export interface UsageData {
  usage: Array<{ id: string; date: CalendarDate; activeUsers: number }>;
  featureUsage: Array<{ id: string; featureKey: string; date: CalendarDate; users: number }>;
  keyFeatures: string[];
  seatsPurchased: number | null;
}

export interface Met {
  date: CalendarDate;
  evidence: Source[];
}

const isWeekend = (d: CalendarDate) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());

function conditionOn(
  c: Condition,
  d: UsageData,
  start: CalendarDate,
  day: CalendarDate,
): Source[] | null {
  const inPlan = <T extends { date: CalendarDate }>(rows: T[]) =>
    rows.filter((r) => r.date >= start && r.date <= day);
  switch (c.metric) {
    case "featureUsed": {
      const rows = inPlan(d.featureUsage)
        .filter((r) => r.featureKey === c.featureKey && r.users > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (rows.length < c.minDays) return null;
      return rows.slice(0, c.minDays).map((r) => ({
        sourceType: "FeatureUsageDaily",
        sourceId: r.id,
        value: r.users,
        date: r.date,
      }));
    }
    case "keyFeaturesUsed": {
      const first = new Map<string, (typeof d.featureUsage)[number]>();
      for (const r of inPlan(d.featureUsage).sort((a, b) => a.date.localeCompare(b.date)))
        if (r.users > 0 && d.keyFeatures.includes(r.featureKey) && !first.has(r.featureKey))
          first.set(r.featureKey, r);
      if (first.size < c.min) return null;
      return [...first.values()].map((r) => ({
        sourceType: "FeatureUsageDaily",
        sourceId: r.id,
        value: r.users,
        date: r.date,
      }));
    }
    case "activeUsers":
    case "activeSeatShare": {
      if (c.metric === "activeSeatShare" && !d.seatsPurchased) return null;
      const byDate = new Map(d.usage.map((u) => [u.date, u]));
      const rows: Source[] = [];
      // B2B use drops at weekends: "N days in a row" means N weekdays in a row, ending on `day`.
      if (isWeekend(day)) return null;
      let date = day;
      for (let k = 0; k < c.days; k++) {
        while (isWeekend(date)) date = addDays(date, -1);
        const u = date >= start ? byDate.get(date) : undefined;
        if (!u) return null;
        const ok =
          c.metric === "activeUsers"
            ? u.activeUsers >= c.min
            : u.activeUsers / d.seatsPurchased! >= c.min;
        if (!ok) return null;
        rows.unshift({
          sourceType: "UsageDaily",
          sourceId: u.id,
          value: u.activeUsers,
          date: u.date,
        });
        date = addDays(date, -1);
      }
      return rows;
    }
  }
}

/** The first date from `start` to `asOf` on which every condition held, or null. Empty list → null. */
export function firstMet(
  conditions: Condition[],
  d: UsageData,
  start: CalendarDate,
  asOf: CalendarDate,
): Met | null {
  if (conditions.length === 0) return null;
  for (let day = start; day <= asOf; day = addDays(day, 1)) {
    const all: Source[] = [];
    let ok = true;
    for (const c of conditions) {
      const ev = conditionOn(c, d, start, day);
      if (!ev) {
        ok = false;
        break;
      }
      all.push(...ev);
    }
    if (ok) return { date: day, evidence: all };
  }
  return null;
}
