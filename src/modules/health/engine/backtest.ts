import { PILLARS, type Pillar } from "./model";
import type { Tier } from "./types";

/**
 * Back-test and proposal search (ARCHITECTURE §4.5, M3 rules 4–5, D-52, D-55). Pure: the pillar
 * scores at each point were computed point-in-time by scoreAsOf; pillar scores do not depend on
 * pillar weights, so every candidate model is evaluated on the same cached points by arithmetic.
 */
export type Band = "HEALTHY" | "WATCH" | "AT_RISK" | "INSUFFICIENT_DATA";

export interface Outcome {
  accountId: string;
  name: string;
  type: "CHURN" | "RENEWAL";
  /** The churn or renewal date (calendar). */
  date: string;
}

export interface BacktestPoint {
  accountId: string;
  outcomeDate: string;
  asOf: string;
  daysBefore: number;
  tier: Tier;
  pillars: Record<Pillar, number | null>;
}

export interface Thresholds {
  healthyMin: number;
  watchMin: number;
}

export interface ModelUnderTest {
  weights: Record<Pillar, number>;
  thresholds: Thresholds;
  perTierOverrides?: Partial<Record<Tier, Thresholds>>;
}

export interface AccountBacktest {
  accountId: string;
  name: string;
  type: Outcome["type"];
  date: string;
  caught: boolean | null;
  leadDays: number | null;
  falseAlarm: boolean | null;
  points: Array<{ asOf: string; daysBefore: number; overall: number | null; band: Band }>;
}

export interface BacktestResult {
  churns: number;
  caught: number;
  meanLeadDays: number | null;
  medianLeadDays: number | null;
  renewals: number;
  falseAlarms: number;
  unscorable: Outcome[];
  accounts: AccountBacktest[];
}

/** Catch counts only at least this many days before the churn (ARCHITECTURE §4.5). */
export const MIN_CATCH_DAYS = 14;
export const MIN_LABELLED = 5;
export const MAX_FALSE_ALARM_RATE = 0.25;
export const HEALTHY_MINS = [60, 65, 70, 75, 80];
export const WATCH_MINS = [35, 40, 45, 50, 55];

const round2 = (x: number) => Math.round(x * 100) / 100;
const key = (o: { accountId: string; date: string; type: string }) =>
  `${o.type}|${o.accountId}|${o.date}`;
const order = (a: Outcome, b: Outcome) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

function overallOf(p: Record<Pillar, number | null>, w: Record<Pillar, number>): number | null {
  let sum = 0;
  let total = 0;
  let n = 0;
  for (const k of PILLARS) {
    const v = p[k];
    if (v === null || w[k] <= 0) continue;
    sum += w[k] * v;
    total += w[k];
    n++;
  }
  return n >= 2 ? round2(sum / total) : null;
}

const scorableByData = (pts: BacktestPoint[]) =>
  pts.some((p) => PILLARS.filter((k) => p.pillars[k] !== null).length >= 2);

function bandOf(overall: number | null, t: Thresholds): Band {
  if (overall === null) return "INSUFFICIENT_DATA";
  return overall >= t.healthyMin ? "HEALTHY" : overall >= t.watchMin ? "WATCH" : "AT_RISK";
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function group(points: BacktestPoint[], outcomes: Outcome[]) {
  const byKey = new Map<string, BacktestPoint[]>();
  for (const p of points) {
    const k = `${p.accountId}|${p.outcomeDate}`;
    byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  return [...outcomes].sort(order).map((o) => ({
    o,
    pts: [...(byKey.get(`${o.accountId}|${o.date}`) ?? [])].sort(
      (a, b) => b.daysBefore - a.daysBefore,
    ),
  }));
}

export function evaluateModel(
  points: BacktestPoint[],
  outcomes: Outcome[],
  m: ModelUnderTest,
): BacktestResult {
  const accounts: AccountBacktest[] = [];
  const unscorable: Outcome[] = [];
  const leads: number[] = [];
  let churns = 0;
  let caught = 0;
  let renewals = 0;
  let falseAlarms = 0;
  for (const { o, pts } of group(points, outcomes)) {
    const scored = pts.map((p) => {
      const overall = overallOf(p.pillars, m.weights);
      return {
        asOf: p.asOf,
        daysBefore: p.daysBefore,
        overall,
        band: bandOf(overall, m.perTierOverrides?.[p.tier] ?? m.thresholds),
      };
    });
    // Whether an outcome can be scored depends on the DATA (≥ 2 pillars with data at some point),
    // never on a candidate's weights, so every candidate is judged on the same accounts (D-67).
    if (!scorableByData(pts)) {
      unscorable.push(o);
      continue;
    }
    if (o.type === "CHURN") {
      churns++;
      // Points are ordered earliest first (most days before), so the first match is the first flag.
      const first = scored.find((s) => s.band === "AT_RISK" && s.daysBefore >= MIN_CATCH_DAYS);
      if (first) {
        caught++;
        leads.push(first.daysBefore);
      }
      accounts.push({
        ...o,
        caught: !!first,
        leadDays: first?.daysBefore ?? null,
        falseAlarm: null,
        points: scored,
      });
    } else {
      renewals++;
      const alarm = scored.some((s) => s.band === "AT_RISK");
      if (alarm) falseAlarms++;
      accounts.push({ ...o, caught: null, leadDays: null, falseAlarm: alarm, points: scored });
    }
  }
  return {
    churns,
    caught,
    meanLeadDays: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null,
    medianLeadDays: median(leads),
    renewals,
    falseAlarms,
    unscorable,
    accounts,
  };
}

/** The spec §6C4 sentence, built only from the numbers (mean lead, D-55). */
export function sentence(r: BacktestResult): string {
  const early =
    r.caught > 0 && r.meanLeadDays !== null
      ? `, on average ${Math.round(r.meanLeadDays)} days early`
      : "";
  return `With this model, we would have flagged ${r.caught} of your last ${r.churns} churns${early}, with ${r.falseAlarms} false alarm${r.falseAlarms === 1 ? "" : "s"} out of ${r.renewals} renewals.`;
}

export interface Candidate {
  weights: Record<Pillar, number>;
  thresholds: Thresholds;
  result: BacktestResult;
}

export interface SearchResult {
  sufficient: boolean;
  reason?: string;
  best: Candidate;
  runnerUp: Candidate | null;
  evaluated: number;
  ms: number;
  step: number;
  /** Pillars with no data at any point: they keep their default weight, nothing is made up. */
  fixedPillars: Pillar[];
}

/** All ways to split `units` into `parts` non-negative integers, in a fixed (lexicographic) order. */
function* compositions(units: number, parts: number): Generator<number[]> {
  if (parts === 1) {
    yield [units];
    return;
  }
  for (let first = units; first >= 0; first--)
    for (const rest of compositions(units - first, parts - 1)) yield [first, ...rest];
}

/**
 * Deterministic proposal: every weight split in `step` increments over the pillars that have
 * data (others keep their default weight) × every threshold pair. Objective: most churns caught,
 * then the longest MEAN lead (D-55), with false alarms ≤ 25% of renewals. Ties go to the weights
 * closest to the default (L1), then to the lexicographically smallest weights.
 */
export function searchWeights(
  points: BacktestPoint[],
  outcomes: Outcome[],
  opts: { step?: number; defaults?: Record<Pillar, number> } = {},
): SearchResult {
  const started = performance.now();
  const step = opts.step ?? 0.05;
  const defaults = opts.defaults ?? {
    ADOPTION: 0.3,
    ENGAGEMENT: 0.15,
    SUPPORT: 0.15,
    RELATIONSHIP: 0.2,
    COMMERCIAL: 0.1,
    SENTIMENT: 0.1,
  };
  const groups = group(points, outcomes);
  const active = PILLARS.filter((k) => points.some((p) => p.pillars[k] !== null));
  const fixedPillars = PILLARS.filter((k) => !active.includes(k));
  const fixedSum = fixedPillars.reduce((s, k) => s + defaults[k], 0);
  const units = Math.round((1 - fixedSum) / step);
  // Every pillar that has data keeps at least one step: a proposal never ignores evidence (D-67).
  const spare = units - active.length;

  const scorable = groups.map((g) => scorableByData(g.pts));
  // Precompute each point's active pillar values once.
  const vals = groups.map((g) => g.pts.map((p) => active.map((k) => p.pillars[k])));
  const base = (w: Record<Pillar, number>, t: Thresholds) =>
    evaluateModel(points, outcomes, { weights: w, thresholds: t });

  const defaultResult = base(defaults, { healthyMin: 70, watchMin: 45 });
  const scorableChurns = defaultResult.churns;
  const scorableRenewals = defaultResult.renewals;
  const thresholds = HEALTHY_MINS.flatMap((h) =>
    WATCH_MINS.filter((w) => w < h).map((w) => ({ healthyMin: h, watchMin: w })),
  );

  type Score = {
    caught: number;
    lead: number;
    fa: number;
    dist: number;
    w: number[];
    t: Thresholds;
    tag: string;
  };
  let best: Score | null = null;
  let second: Score | null = null;
  let evaluated = 0;
  const better = (a: Score, b: Score) => {
    const feasA = a.fa <= MAX_FALSE_ALARM_RATE * scorableRenewals + 1e-9;
    const feasB = b.fa <= MAX_FALSE_ALARM_RATE * scorableRenewals + 1e-9;
    if (feasA !== feasB) return feasA;
    if (!feasA && a.fa !== b.fa) return a.fa < b.fa;
    if (a.caught !== b.caught) return a.caught > b.caught;
    if (Math.abs(a.lead - b.lead) > 1e-9) return a.lead > b.lead;
    if (Math.abs(a.dist - b.dist) > 1e-9) return a.dist < b.dist;
    return a.tag < b.tag;
  };

  // Nothing to search (no pillar has data at any point): the default model, reported as such.
  const splits = active.length === 0 || spare < 0 ? [] : compositions(spare, active.length);
  for (const split of splits) {
    const w = split.map((u) => (u + 1) * step);
    const dist = active.reduce((s, k, i) => s + Math.abs(w[i]! - defaults[k]), 0);
    // Overall per point for this weight split (null when < 2 weighted pillars have data).
    const overall = vals.map((pts) =>
      pts.map((v) => {
        let sum = 0;
        let total = 0;
        let n = 0;
        for (let i = 0; i < v.length; i++) {
          const x = v[i];
          if (x === null || x === undefined || w[i]! <= 0) continue;
          sum += w[i]! * x;
          total += w[i]!;
          n++;
        }
        return n >= 2 ? Math.round((sum / total) * 100) / 100 : null;
      }),
    );
    for (const t of thresholds) {
      evaluated++;
      let caught = 0;
      let leadSum = 0;
      let fa = 0;
      groups.forEach((g, gi) => {
        const ov = overall[gi]!;
        if (!scorable[gi]) return;
        if (g.o.type === "CHURN") {
          const idx = g.pts.findIndex(
            (p, pi) => ov[pi] !== null && ov[pi]! < t.watchMin && p.daysBefore >= MIN_CATCH_DAYS,
          );
          if (idx >= 0) {
            caught++;
            leadSum += g.pts[idx]!.daysBefore;
          }
        } else if (ov.some((x) => x !== null && x < t.watchMin)) fa++;
      });
      const s: Score = {
        caught,
        lead: caught ? leadSum / caught : 0,
        fa,
        dist,
        w,
        t,
        tag: `${w.map((x) => x.toFixed(2)).join(",")}|${t.healthyMin}|${t.watchMin}`,
      };
      if (!best || better(s, best)) {
        second = best;
        best = s;
      } else if (!second || better(s, second)) second = s;
    }
  }

  const toWeights = (w: number[]) =>
    Object.fromEntries(
      PILLARS.map((k) => [
        k,
        active.includes(k) ? Math.round(w[active.indexOf(k)]! * 1e6) / 1e6 : defaults[k],
      ]),
    ) as Record<Pillar, number>;
  const toCandidate = (s: Score): Candidate => {
    const weights = toWeights(s.w);
    return { weights, thresholds: s.t, result: base(weights, s.t) };
  };
  const sufficient = scorableChurns >= MIN_LABELLED && scorableRenewals >= MIN_LABELLED;
  const fallback: Candidate = {
    weights: defaults,
    thresholds: { healthyMin: 70, watchMin: 45 },
    result: defaultResult,
  };
  return {
    sufficient,
    reason: sufficient
      ? undefined
      : `${scorableChurns} churned and ${scorableRenewals} renewed accounts could be scored; ${MIN_LABELLED} of each are needed.`,
    best: best ? toCandidate(best) : fallback,
    runnerUp: second ? toCandidate(second) : null,
    evaluated,
    ms: Math.round(performance.now() - started),
    step,
    fixedPillars,
  };
}
