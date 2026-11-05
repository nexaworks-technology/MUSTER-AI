import type { Figure, FigureSources, FigureUnit, SourceLink } from "./types";

/** Pages for each record type a report cites. Record ids resolve to the account's own tabs. */
const LINK_CAP = 50;

export interface Row {
  id: string;
  accountId?: string | null;
  label?: string;
}

const tab: Record<string, string> = {
  Account: "",
  HealthScoreSnapshot: "/health",
  Renewal: "/renewal",
  RenewalOutcome: "/renewal",
  Ticket: "/tickets",
  Signal: "/signals",
  ExpansionOpportunity: "/expansion",
  OnboardingPlan: "/onboarding",
  Task: "/tasks",
  UsageDaily: "/adoption",
};

function linkFor(type: string, r: Row): SourceLink | null {
  if (type === "Approval") return { id: r.id, href: "/approvals", label: r.label };
  if (type === "OutcomeRecord") return { id: r.id, href: "/reports/outcomes", label: r.label };
  if (type === "Membership") return null;
  const accountId = type === "Account" ? r.id : r.accountId;
  if (!accountId || !(type in tab)) return null;
  return { id: r.id, href: `/accounts/${accountId}${tab[type]}`, label: r.label };
}

export function sourcesOf(type: string, rows: readonly Row[]): FigureSources {
  const links = rows.flatMap((r) => linkFor(type, r) ?? []).slice(0, LINK_CAP);
  return { type, ids: rows.map((r) => r.id), ...(links.length ? { links } : {}) };
}

export const noSources = (type: string): FigureSources => ({ type, ids: [] });

/** A count of records. Zero records is a real zero here: the records were looked for and none exist. */
export function count(label: string, type: string, rows: readonly Row[], href?: string): Figure {
  return { label, value: rows.length, unit: "count", sources: sourcesOf(type, rows), href };
}

/** `part` of `whole`, as a whole-number percent; no whole means no figure, not 0%. */
export function percent(
  label: string,
  type: string,
  part: readonly Row[],
  whole: readonly Row[],
  reason: string,
  href?: string,
): Figure {
  if (whole.length === 0) return missing(label, "percent", type, reason);
  return {
    label,
    value: Math.round((part.length / whole.length) * 100),
    unit: "percent",
    sources: sourcesOf(type, whole),
    href,
  };
}

export function missing(label: string, unit: FigureUnit, type: string, reason: string): Figure {
  return { label, value: null, unit, sources: noSources(type), reason };
}

/** A number computed from records (a median, an average) with the records it came from. */
export function measure(
  label: string,
  unit: FigureUnit,
  value: number | null,
  type: string,
  rows: readonly Row[],
  reason: string,
  href?: string,
): Figure {
  if (value === null) return missing(label, unit, type, reason);
  return { label, value, unit, sources: sourcesOf(type, rows), href };
}

/**
 * Money, in one currency. `minor` null (no amount on file) is "no data", never 0. The value is a
 * string so the stored JSON keeps every digit.
 */
export function money(
  label: string,
  minor: bigint | null,
  currency: string | null,
  type: string,
  rows: readonly Row[],
  reason: string,
  href?: string,
): Figure {
  if (minor === null || currency === null)
    return { ...missing(label, "money", type, reason), currency };
  return {
    label,
    value: minor.toString(),
    unit: "money",
    currency,
    sources: sourcesOf(type, rows),
    href,
  };
}

/** Sum of the amounts that exist; null when none of them exist (never 0 for "unknown"). */
export function sumKnown<T>(rows: readonly T[], pick: (r: T) => bigint | null): bigint | null {
  let total: bigint | null = null;
  for (const r of rows) {
    const v = pick(r);
    if (v !== null) total = (total ?? 0n) + v;
  }
  return total;
}

export const qs = (...parts: Array<[string, string | undefined | null]>): string =>
  parts
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join("&");

export function withQuery(path: string, ...queries: string[]): string {
  const q = queries.filter(Boolean).join("&");
  return q ? `${path}?${q}` : path;
}
