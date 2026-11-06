import type { ProductEventName } from "@/lib/pilot/events";

/**
 * Pilot metrics (M12 B5, spec §11): pure arithmetic over ProductEvent rows. Per member per ISO
 * week and for the whole period: Today/Approvals opens, flag acceptance, QBR/brief prep time.
 * Every figure names the ProductEvent ids it was computed from (Rule 1); a figure with nothing to
 * compute from has `value: null` and a reason, never 0 (Rule 4). Opens are the exception: a week
 * with no opens is a real 0, because the events were looked for.
 */
export interface PilotEvent {
  id: string;
  membershipId: string;
  name: string;
  subjectId: string | null;
  occurredAt: Date;
}

export type PilotUnit = "count" | "percent" | "minutes";

export interface PilotFigure {
  label: string;
  value: number | null;
  unit: PilotUnit;
  sources: { type: "ProductEvent"; ids: string[] };
  reason?: string;
}

export const PILOT_FIGURE_KEYS = [
  "todayOpens",
  "approvalsOpens",
  "flagAcceptance",
  "qbrPrepMedian",
  "qbrPrepP90",
  "briefPrepMedian",
  "briefPrepP90",
] as const;
export type PilotFigureKey = (typeof PILOT_FIGURE_KEYS)[number];
export type PilotFigures = Record<PilotFigureKey, PilotFigure>;

export interface PilotMember {
  id: string;
  name: string;
}

export interface PilotMemberMetrics {
  membershipId: string;
  name: string;
  weekly: Record<string, PilotFigures>;
  period: PilotFigures;
}

export interface PilotMetrics {
  weeks: Array<{ label: string; start: string }>;
  periodStart: string;
  periodEnd: string;
  members: PilotMemberMetrics[];
}

// ─── Dates ───────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const utcDay = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const ymdOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The calendar date of an instant in a timezone, as YYYY-MM-DD. */
export function localDate(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** ISO 8601 week of a calendar date: "2026-W45" and the Monday that starts it. */
export function isoWeekOf(ymd: string): { label: string; start: string } {
  const t = utcDay(ymd);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  const monday = t - dow * DAY;
  const thursday = monday + 3 * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY)) + 1;
  return { label: `${year}-W${String(week).padStart(2, "0")}`, start: ymdOf(monday) };
}

/** The last `count` ISO weeks, oldest first, ending with the week that contains `asOf`. */
export function weeksEndingAt(asOf: string, count: number) {
  const last = utcDay(isoWeekOf(asOf).start);
  return Array.from({ length: count }, (_, i) =>
    isoWeekOf(ymdOf(last - (count - 1 - i) * 7 * DAY)),
  );
}

// ─── Statistics ──────────────────────────────────────────────────────────────

/** Nearest-rank percentile; p = 0.5 is the usual median (mean of the middle two). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  if (p === 0.5) {
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  }
  return s[Math.min(s.length, Math.max(1, Math.ceil(p * s.length))) - 1]!;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ─── Figures ─────────────────────────────────────────────────────────────────

const src = (ids: string[]) => ({ type: "ProductEvent" as const, ids });

const opens = (label: string, rows: PilotEvent[]): PilotFigure => ({
  label,
  value: rows.length,
  unit: "count",
  sources: src(rows.map((r) => r.id)),
});

/**
 * One verdict per signal: a false alarm beats an earlier acknowledgement (the person changed their
 * mind), and repeated accepts of the same signal count once. Events without a signal id count each.
 */
function flagVerdicts(rows: PilotEvent[]): PilotEvent[] {
  const falseIds = new Set(
    rows.filter((r) => r.name === "signal.false_alarm" && r.subjectId).map((r) => r.subjectId),
  );
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (r.name === "signal.flag_accepted" && r.subjectId && falseIds.has(r.subjectId)) return false;
    if (!r.subjectId) return true;
    const key = `${r.name}:${r.subjectId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function flagAcceptance(all: PilotEvent[]): PilotFigure {
  const rows = flagVerdicts(all);
  const accepted = rows.filter((r) => r.name === "signal.flag_accepted");
  const total = rows.length;
  const label = "Flag acceptance";
  if (total === 0)
    return {
      label,
      value: null,
      unit: "percent",
      sources: src([]),
      reason: "No flags were acted on or marked false alarm in this period.",
    };
  return {
    label,
    value: Math.round((accepted.length / total) * 100),
    unit: "percent",
    sources: src(rows.map((r) => r.id)),
  };
}

interface Pair {
  minutes: number;
  ids: [string, string];
  member: string;
  sharedAt: Date;
}

/** One pair per document: earliest generated, then the first share at or after it. */
export function prepPairs(events: PilotEvent[], kind: "brief" | "qbr"): Pair[] {
  const bySubject = new Map<string, { gen?: PilotEvent; shares: PilotEvent[] }>();
  for (const e of events) {
    if (!e.subjectId) continue;
    const slot = bySubject.get(e.subjectId) ?? { shares: [] };
    if (e.name === `${kind}.generated`) {
      if (!slot.gen || e.occurredAt < slot.gen.occurredAt) slot.gen = e;
    } else if (e.name === `${kind}.shared`) slot.shares.push(e);
    else continue;
    bySubject.set(e.subjectId, slot);
  }
  const pairs: Pair[] = [];
  for (const { gen, shares } of bySubject.values()) {
    if (!gen) continue;
    const shared = shares
      .filter((s) => s.occurredAt >= gen.occurredAt)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())[0];
    if (!shared) continue;
    pairs.push({
      minutes: (shared.occurredAt.getTime() - gen.occurredAt.getTime()) / 60_000,
      ids: [gen.id, shared.id],
      member: gen.membershipId,
      sharedAt: shared.occurredAt,
    });
  }
  return pairs;
}

function prep(label: string, pairs: Pair[], p: number): PilotFigure {
  const value = percentile(
    pairs.map((x) => x.minutes),
    p,
  );
  if (value === null)
    return {
      label,
      value: null,
      unit: "minutes",
      sources: src([]),
      reason: "No document was both generated and shared in this period.",
    };
  return {
    label,
    value: round1(value),
    unit: "minutes",
    sources: src(pairs.flatMap((x) => x.ids)),
  };
}

interface Bucket {
  events: PilotEvent[];
  qbr: Pair[];
  brief: Pair[];
}

function figuresFor(b: Bucket): PilotFigures {
  const by = (n: ProductEventName) => b.events.filter((e) => e.name === n);
  return {
    todayOpens: opens("Today opens", by("today.opened")),
    approvalsOpens: opens("Approvals opens", by("approvals.opened")),
    flagAcceptance: flagAcceptance(
      b.events.filter((e) => e.name === "signal.flag_accepted" || e.name === "signal.false_alarm"),
    ),
    qbrPrepMedian: prep("QBR prep time, median", b.qbr, 0.5),
    qbrPrepP90: prep("QBR prep time, p90", b.qbr, 0.9),
    briefPrepMedian: prep("Brief prep time, median", b.brief, 0.5),
    briefPrepP90: prep("Brief prep time, p90", b.brief, 0.9),
  };
}

export interface ComputeInput {
  events: PilotEvent[];
  members: PilotMember[];
  /** How many ISO weeks to cover, ending with the week of `asOf`. */
  weeks: number;
  /** Today in the workspace timezone, YYYY-MM-DD. */
  asOf: string;
  timezone: string;
}

export function computePilotMetrics(input: ComputeInput): PilotMetrics {
  const weeks = weeksEndingAt(input.asOf, input.weeks);
  const weekOf = (d: Date) => isoWeekOf(localDate(d, input.timezone)).label;
  const known = new Set(input.members.map((m) => m.id));

  const events = input.events.filter((e) => known.has(e.membershipId));
  const pairs = {
    qbr: prepPairs(events, "qbr"),
    brief: prepPairs(events, "brief"),
  };

  const members = input.members.map((m): PilotMemberMetrics => {
    const mine = events.filter((e) => e.membershipId === m.id);
    const weekly: Record<string, PilotFigures> = {};
    const period: Bucket = { events: [], qbr: [], brief: [] };
    for (const w of weeks) {
      const b: Bucket = {
        events: mine.filter((e) => weekOf(e.occurredAt) === w.label),
        qbr: pairs.qbr.filter((p) => p.member === m.id && weekOf(p.sharedAt) === w.label),
        brief: pairs.brief.filter((p) => p.member === m.id && weekOf(p.sharedAt) === w.label),
      };
      weekly[w.label] = figuresFor(b);
      // Prep pairs are counted in the week they were shared; the rest by when they happened.
      period.events.push(...b.events);
      period.qbr.push(...b.qbr);
      period.brief.push(...b.brief);
    }
    return { membershipId: m.id, name: m.name, weekly, period: figuresFor(period) };
  });

  return {
    weeks,
    periodStart: weeks[0]!.start,
    periodEnd: ymdOf(utcDay(weeks[weeks.length - 1]!.start) + 6 * DAY),
    members,
  };
}
