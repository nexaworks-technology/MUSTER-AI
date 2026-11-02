import { addDays, type CalendarDate } from "@/lib/dates";
import { TIER_WORDS } from "./format";
import type { CohortBaseline, OwnBaseline, Tier } from "./types";
import { typicalWeekday, type Usage } from "./windows";

/**
 * Baselines (ARCHITECTURE §4.2), pure. The SQL in ../baselines-sql.ts computes the same numbers
 * set-based for the nightly run; an integration test proves the two agree.
 */

/** percentile_cont: linear interpolation between the closest ranks (Postgres semantics). */
export function percentile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export const OWN_WEEKS = 13;

/** 13 weekly "typical weekday" values ending 14, 21, … 98 days before the as-of date. */
export function ownBaseline(rows: Usage, asOf: CalendarDate): OwnBaseline {
  const from = addDays(asOf, -104);
  const to = addDays(asOf, -14);
  const known = rows.filter((r) => r.date <= asOf);
  const historyDays = new Set(
    known.filter((r) => r.date >= from && r.date <= to).map((r) => r.date),
  ).size;
  const first = known
    .filter((r) => r.date <= to)
    .reduce<string | null>((m, r) => (m === null || r.date < m ? r.date : m), null);
  const weekly: number[] = [];
  if (first !== null)
    for (let k = 0; k < OWN_WEEKS; k++) {
      const end = addDays(to, -7 * k);
      // A week that starts before the account's first day of data is not "zero usage".
      if (addDays(end, -6) >= first) weekly.push(typicalWeekday(known, end));
    }
  return { median: percentile(weekly, 0.5), p25: percentile(weekly, 0.25), historyDays, from, to };
}

export interface Peer {
  id: string;
  tier: Tier;
  plan: string | null;
  employeeBand: string | null;
  useCase: string | null;
  /** Typical weekday active users ÷ seats bought, now; null when it cannot be computed. */
  rate: number | null;
}

type Attr = "tier" | "plan" | "employeeBand" | "useCase";
const KEY: Record<Attr, string> = {
  tier: "tier",
  plan: "plan",
  employeeBand: "band",
  useCase: "useCase",
};

/** Fallback: drop use case → drop company size → tier only (ARCHITECTURE §4.2). */
const LEVELS: Attr[][] = [
  ["tier", "plan", "employeeBand", "useCase"],
  ["tier", "plan", "employeeBand"],
  ["tier", "plan"],
  ["tier"],
];

function label(me: Peer, attrs: Attr[]): string {
  let s = `${TIER_WORDS[me.tier]} accounts`;
  if (attrs.includes("plan")) s += ` on the ${me.plan} plan`;
  if (attrs.includes("employeeBand")) s += ` with ${me.employeeBand} employees`;
  if (attrs.includes("useCase")) s += ` used for ${me.useCase}`;
  return s;
}

export function cohortBaseline(me: Peer, peers: Peer[], minPeers: number): CohortBaseline {
  const usable = peers.filter((p) => p.id !== me.id && p.rate !== null);
  const levels = LEVELS.filter((attrs) => attrs.every((a) => me[a] !== null));
  let chosen: CohortBaseline | null = null;
  for (const attrs of levels) {
    const match = usable.filter((p) => attrs.every((a) => p[a] === me[a]));
    chosen = {
      key: attrs.map((a) => `${KEY[a]}=${me[a]}`).join("|"),
      label: label(me, attrs),
      size: match.length,
      medianRate: percentile(
        match.map((p) => p.rate!),
        0.5,
      ),
    };
    if (match.length >= minPeers) return chosen;
  }
  return chosen!;
}
