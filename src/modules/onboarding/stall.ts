import { daysBetween, type CalendarDate } from "@/lib/dates";
import type { Source, TtvResult } from "./ttv";

/**
 * The one definition of "stalled" (M6 D4). Pure: the five ONBOARDING_* signal rules and the
 * nightly `onboarding.evaluate` job both call these functions on the same facts, so a stall can
 * never mean two things. Thresholds are the rules' params (audited workspace settings).
 *
 * Blocker order (D2): an overdue step on our side first (we can act on it today), then the
 * customer's, then no activity, then a key feature unused, then time to value past the cohort's
 * P75; within a class, more days first. Missing usage data never creates a blocker (Rule 4): it
 * becomes a missing-data note instead.
 */
export interface OnboardingFacts {
  planId: string;
  startDate: CalendarDate;
  asOf: CalendarDate;
  valueReachedAt: CalendarDate | null;
  steps: Array<{
    id: string;
    title: string;
    ownerSide: "US" | "CUSTOMER";
    dueDate: CalendarDate;
    doneDate: CalendarDate | null;
    blockedReason: string | null;
  }>;
  /** null = no product usage data source for this account. */
  usage: Array<{ id: string; date: CalendarDate; activeUsers: number }> | null;
  /** null = no feature usage data. */
  featureUsage: Array<{
    id?: string;
    featureKey: string;
    date: CalendarDate;
    users: number;
  }> | null;
  keyFeatures: Array<{ featureKey: string; label: string }>;
  ttv: TtvResult | null;
}

export interface StallParams {
  /** A step this many days past due (or more) is a blocker. */
  stepOverdueDays: number;
  /** No active user for this many days is a blocker. */
  noActivityDays: number;
  /** Every key feature should have been used by this plan day. */
  keyFeatureByDay: number;
}

export const DEFAULT_STALL_PARAMS: StallParams = {
  stepOverdueDays: 3,
  noActivityDays: 7,
  keyFeatureByDay: 30,
};

export type BlockerKind =
  "STEP_OVERDUE_US" | "STEP_OVERDUE_CUSTOMER" | "NO_ACTIVITY" | "KEY_FEATURE_UNUSED" | "TTV_LATE";

export const BLOCKER_ORDER: readonly BlockerKind[] = [
  "STEP_OVERDUE_US",
  "STEP_OVERDUE_CUSTOMER",
  "NO_ACTIVITY",
  "KEY_FEATURE_UNUSED",
  "TTV_LATE",
];

export interface Blocker {
  kind: BlockerKind;
  /** What the blocker is about: the step id, or the feature key. */
  ref?: string;
  text: string;
  days: number;
  sources: Source[];
}

export interface StallResult {
  stalled: boolean;
  /** The likely blocker in plain words (the first one), or null. */
  reason: string | null;
  blockers: Blocker[];
  missing: string[];
}

export function overdueSteps(
  f: OnboardingFacts,
  side: "US" | "CUSTOMER",
  p: StallParams,
): Blocker[] {
  return f.steps
    .filter((s) => s.ownerSide === side && s.doneDate === null && s.dueDate < f.asOf)
    .map((s) => ({ s, days: daysBetween(s.dueDate, f.asOf) }))
    .filter(({ days }) => days >= p.stepOverdueDays)
    .map(({ s, days }) => ({
      kind: side === "US" ? ("STEP_OVERDUE_US" as const) : ("STEP_OVERDUE_CUSTOMER" as const),
      ref: s.id,
      text: `${s.title} (${side === "US" ? "us" : "customer"}) overdue ${days} days${s.blockedReason ? `: ${s.blockedReason}` : ""}`,
      days,
      sources: [{ sourceType: "OnboardingStep", sourceId: s.id, value: days, date: s.dueDate }],
    }));
}

export function noActivity(f: OnboardingFacts, p: StallParams): Blocker | null {
  if (!f.usage || f.valueReachedAt) return null;
  const active = f.usage.filter((u) => u.activeUsers > 0 && u.date <= f.asOf);
  const last = active.reduce<(typeof active)[number] | null>(
    (m, u) => (m === null || u.date > m.date ? u : m),
    null,
  );
  // Measured from the last active day, or from the start when nobody has ever logged in.
  const since = last?.date ?? f.startDate;
  const days = daysBetween(since, f.asOf);
  if (days < p.noActivityDays) return null;
  return {
    kind: "NO_ACTIVITY",
    text: last
      ? `No one has used the product for ${days} days`
      : `No one has used the product since the start, ${days} days ago`,
    days,
    sources: last
      ? [{ sourceType: "UsageDaily", sourceId: last.id, value: last.activeUsers, date: last.date }]
      : [{ sourceType: "OnboardingPlan", sourceId: f.planId, value: days, date: f.startDate }],
  };
}

export function keyFeaturesUnused(f: OnboardingFacts, p: StallParams): Blocker[] {
  if (!f.featureUsage || f.valueReachedAt) return [];
  const day = daysBetween(f.startDate, f.asOf);
  if (day < p.keyFeatureByDay) return [];
  const used = new Set(
    f.featureUsage
      .filter((u) => u.users > 0 && u.date >= f.startDate && u.date <= f.asOf)
      .map((u) => u.featureKey),
  );
  return f.keyFeatures
    .filter((k) => !used.has(k.featureKey))
    .map((k) => ({
      kind: "KEY_FEATURE_UNUSED" as const,
      ref: k.featureKey,
      text: `${k.label} not used by day ${day} (expected by day ${p.keyFeatureByDay})`,
      days: day - p.keyFeatureByDay,
      // Proof of absence: the account's feature rows over the whole plan show no use.
      sources: [
        { sourceType: "FeatureUsageDaily", from: f.startDate, to: f.asOf, value: 0, date: f.asOf },
      ],
    }));
}

export function ttvLate(f: OnboardingFacts): Blocker | null {
  if (!f.ttv || f.ttv.state !== "NOT_REACHED" || f.ttv.verdict !== "LATE") return null;
  return {
    kind: "TTV_LATE",
    text: f.ttv.reason,
    days: f.ttv.days ?? 0,
    sources: f.ttv.sources.length
      ? f.ttv.sources
      : [
          {
            sourceType: "OnboardingPlan",
            sourceId: f.planId,
            value: f.ttv.days,
            date: f.startDate,
          },
        ],
  };
}

export function detectStall(f: OnboardingFacts, p: StallParams): StallResult {
  const missing: string[] = [];
  if (f.usage === null)
    missing.push("No product usage data for this account, so logins could not be checked.");
  if (f.featureUsage === null)
    missing.push("No feature usage data for this account, so key features could not be checked.");
  const blockers = [
    ...overdueSteps(f, "US", p),
    ...overdueSteps(f, "CUSTOMER", p),
    ...[noActivity(f, p)].filter((b): b is Blocker => b !== null),
    ...keyFeaturesUnused(f, p),
    ...[f.valueReachedAt ? null : ttvLate(f)].filter((b): b is Blocker => b !== null),
  ].sort(
    (a, b) => BLOCKER_ORDER.indexOf(a.kind) - BLOCKER_ORDER.indexOf(b.kind) || b.days - a.days,
  );
  return { stalled: blockers.length > 0, reason: blockers[0]?.text ?? null, blockers, missing };
}

/** What the signal bundle carries for an account with an open plan (loaded by the onboarding module). */
export interface OnboardingPlanFacts {
  planId: string;
  startDate: CalendarDate;
  valueReachedAt: CalendarDate | null;
  steps: OnboardingFacts["steps"];
  ttv: TtvResult | null;
}

/** The facts stall.ts reads, from a signal bundle: usage comes from the bundle itself (D4). */
export function factsFromBundle(b: {
  asOf: CalendarDate;
  onboarding?: OnboardingPlanFacts | null;
  usage: Array<{ id: string; date: CalendarDate; activeUsers: number }> | null;
  featureUsage: Array<{
    id?: string;
    featureKey: string;
    date: CalendarDate;
    users: number;
  }> | null;
  keyFeatures: Array<{ featureKey: string; label: string }>;
}): OnboardingFacts | null {
  if (!b.onboarding) return null;
  return {
    ...b.onboarding,
    asOf: b.asOf,
    usage: b.usage,
    featureUsage: b.featureUsage,
    keyFeatures: b.keyFeatures,
  };
}
