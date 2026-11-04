import type { CalendarDate } from "@/lib/dates";
import { calendarDateOf, daysBetween } from "@/lib/dates";

/**
 * Coverage (spec §6N): accounts with no two-way contact in the last N days (default 30). An
 * account with no contact on record at all is listed apart ("No contact recorded"), never
 * counted as "silent for N days" (Rule 4). Pure.
 */
export interface CoverageAccount {
  id: string;
  name: string;
  lastTouchAt: Date | null;
}

export interface Coverage {
  days: number;
  total: number;
  covered: number;
  untouched: Array<{ id: string; name: string; daysSince: number }>;
  noContactRecorded: Array<{ id: string; name: string }>;
}

export const DEFAULT_COVERAGE_DAYS = 30;

export function coverage(
  accounts: readonly CoverageAccount[],
  asOf: CalendarDate,
  days = DEFAULT_COVERAGE_DAYS,
): Coverage {
  const out: Coverage = {
    days,
    total: accounts.length,
    covered: 0,
    untouched: [],
    noContactRecorded: [],
  };
  for (const a of accounts) {
    if (!a.lastTouchAt) {
      out.noContactRecorded.push({ id: a.id, name: a.name });
      continue;
    }
    const since = daysBetween(calendarDateOf(a.lastTouchAt), asOf);
    if (since > days) out.untouched.push({ id: a.id, name: a.name, daysSince: since });
    else out.covered++;
  }
  out.untouched.sort((a, b) => b.daysSince - a.daysSince || a.name.localeCompare(b.name));
  out.noContactRecorded.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
