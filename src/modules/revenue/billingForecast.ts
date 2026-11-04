import { calendarDateOf, type CalendarDate } from "@/lib/dates";

/**
 * Expected billing from subscriptions (spec §6N). A schedule, not a prediction: every active or
 * past-due subscription is assumed to bill again at each interval after its current period end,
 * and the page says so. A cancelled or ended subscription bills nothing after its period end and
 * is listed as excluded. A subscription with no period end on file is listed too, never guessed.
 * Money stays per currency; each month lists the subscription ids behind its sum (Rule 1).
 */
export interface ForecastSubscription {
  id: string;
  accountId: string;
  interval: "MONTH" | "YEAR";
  amountMinor: bigint;
  currency: string;
  status: "ACTIVE" | "PAST_DUE" | "CANCELLED" | "ENDED";
  currentPeriodEnd: Date | null;
}

export interface BillingMonth {
  month: string; // YYYY-MM
  currency: string;
  amountMinor: bigint;
  subscriptionIds: string[];
}

export interface BillingForecast {
  from: CalendarDate;
  months: number;
  rows: BillingMonth[];
  excluded: Array<{ id: string; reason: "CANCELLED" | "ENDED" | "NO_PERIOD_END" }>;
}

/** Adds calendar months to a YYYY-MM-DD date, clamping to the month's last day. */
export function addMonths(d: CalendarDate, n: number): CalendarDate {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

export function billingForecast(
  subs: readonly ForecastSubscription[],
  from: CalendarDate,
  months: number,
): BillingForecast {
  const end = addMonths(from, months);
  const rows = new Map<string, BillingMonth>();
  const excluded: BillingForecast["excluded"] = [];
  for (const s of [...subs].sort((a, b) => a.id.localeCompare(b.id))) {
    if (s.status === "CANCELLED" || s.status === "ENDED") {
      excluded.push({ id: s.id, reason: s.status });
      continue;
    }
    if (!s.currentPeriodEnd) {
      excluded.push({ id: s.id, reason: "NO_PERIOD_END" });
      continue;
    }
    const step = s.interval === "MONTH" ? 1 : 12;
    const anchor = calendarDateOf(s.currentPeriodEnd);
    for (let k = 0; ; k++) {
      const due = addMonths(anchor, k * step);
      if (due >= end) break;
      if (due < from) continue;
      const key = `${due.slice(0, 7)}|${s.currency}`;
      const row = rows.get(key) ?? {
        month: due.slice(0, 7),
        currency: s.currency,
        amountMinor: 0n,
        subscriptionIds: [],
      };
      row.amountMinor += s.amountMinor;
      row.subscriptionIds.push(s.id);
      rows.set(key, row);
    }
  }
  return {
    from,
    months,
    rows: [...rows.values()].sort(
      (a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency),
    ),
    excluded,
  };
}
