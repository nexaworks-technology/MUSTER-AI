/**
 * All seed dates are relative to SEED_TODAY (default 2026-11-02, a Monday). Times are 14:00 UTC,
 * which is 09:00 in the demo workspace's America/New_York time zone after the November clock change.
 */
export const SEED_TODAY = process.env.SEED_TODAY ?? "2026-11-02";
const BASE = Date.parse(`${SEED_TODAY}T14:00:00.000Z`);
const DAY = 86_400_000;

export const daysAgo = (n: number): Date => new Date(BASE - n * DAY);
export const daysFromNow = (n: number): Date => new Date(BASE + n * DAY);
export const atHour = (date: Date, hourUtc: number, minute = 0): Date => {
  const d = new Date(date);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d;
};
/** Calendar date (UTC midnight) n days before SEED_TODAY, for daily series. */
export const dayKey = (n: number): Date =>
  new Date(Date.parse(`${SEED_TODAY}T00:00:00.000Z`) - n * DAY);
