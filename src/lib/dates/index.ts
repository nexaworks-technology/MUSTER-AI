/**
 * Calendar maths in the workspace's time zone (D-50, M3 rule 7).
 *
 * - A **calendar date** is a `YYYY-MM-DD` string. Day counts are differences between calendar
 *   dates, never milliseconds divided by a day, so DST changes cannot shift them.
 * - A **moment** (a message sent, a ticket opened) belongs to the workspace-local date it falls on.
 * - A stored **calendar field** (renewal, due date, usage day) is kept at UTC midnight (D-50) and
 *   read as its UTC day.
 * - "Today" always comes from an injected clock, so no test depends on the real one.
 */
export type CalendarDate = string;
export type Clock = () => Date;

/** Real wall-clock time: record and audit timestamps, expiries, durations. Never faked. */
export const realClock: Clock = () => new Date();

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The business "now" (Q-49, D-81): real time, unless a test harness sets BOTH
 * `ALLOW_FAKE_CLOCK=true` and `APP_FAKE_NOW` (an ISO 8601 instant) outside production. The e2e
 * app and worker pin it to the seed's day, so asynchronous jobs (activation re-scores, the nightly
 * pipeline) can never date the frozen test world "today". Production always gets real time.
 */
export function businessNow(
  source: Record<string, string | undefined> = process.env,
  real: Clock = realClock,
): Date {
  if (
    source.NODE_ENV === "production" ||
    source.ALLOW_FAKE_CLOCK !== "true" ||
    !source.APP_FAKE_NOW
  )
    return real();
  const fake = source.APP_FAKE_NOW;
  const at = new Date(fake);
  if (!ISO_INSTANT.test(fake) || Number.isNaN(at.getTime()))
    throw new Error("APP_FAKE_NOW must be an ISO 8601 instant, e.g. 2026-11-02T17:00:00Z");
  return at;
}

/**
 * The clock for business dates: scoring as-of, signal evaluation, Today, escalation, outcome
 * checkpoints, send guards, agent budgets. Services take it as their default injected clock.
 */
export const businessClock: Clock = () => businessNow();
export const fixedClock =
  (iso: string): Clock =>
  () =>
    new Date(iso);

const PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(d: CalendarDate): [number, number, number] {
  const m = PATTERN.exec(d);
  if (!m) throw new Error(`Not a calendar date: ${d}`);
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, da));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== da)
    throw new Error(`Not a calendar date: ${d}`);
  return [y, mo, da];
}

const fmt = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = fmt.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    fmt.set(timeZone, f);
  }
  return f;
}

function wallClock(moment: Date, timeZone: string) {
  const p = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(moment)
      .map((x) => [x.type, x.value]),
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    ms: Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!),
  };
}

/** The workspace-local calendar date a moment falls on. */
export function localDate(moment: Date, timeZone: string): CalendarDate {
  return wallClock(moment, timeZone).date;
}

/** A stored calendar field (UTC midnight, D-50) read as its own day. */
export function calendarDateOf(date: Date): CalendarDate {
  return date.toISOString().slice(0, 10);
}

/** The UTC-midnight instant a calendar date is stored as (D-50). */
export function utcMidnight(d: CalendarDate): Date {
  const [y, m, da] = parts(d);
  return new Date(Date.UTC(y, m - 1, da));
}

/** The first instant of a local day: moments before it are on or before the previous day. */
export function startOfLocalDay(d: CalendarDate, timeZone: string): Date {
  let guess = utcMidnight(d).getTime();
  // Two passes settle the offset, including on a DST change day.
  for (let i = 0; i < 2; i++) {
    const offset = wallClock(new Date(guess), timeZone).ms - guess;
    guess = utcMidnight(d).getTime() - offset;
  }
  return new Date(guess);
}

/** True when the moment falls on the as-of date or earlier, in the workspace's zone. */
export function isOnOrBefore(moment: Date, asOf: CalendarDate, timeZone: string): boolean {
  return localDate(moment, timeZone) <= asOf;
}

/** Calendar days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: CalendarDate, b: CalendarDate): number {
  return Math.round((utcMidnight(b).getTime() - utcMidnight(a).getTime()) / 86_400_000);
}

export function addDays(d: CalendarDate, n: number): CalendarDate {
  const t = utcMidnight(d);
  t.setUTCDate(t.getUTCDate() + n);
  return calendarDateOf(t);
}

export function todayIn(timeZone: string, clock: Clock = businessClock): CalendarDate {
  return localDate(clock(), timeZone);
}
