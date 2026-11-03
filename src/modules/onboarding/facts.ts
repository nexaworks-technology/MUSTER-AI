import type { OnboardingPlan, OnboardingStep, OnboardingTemplate } from "@prisma/client";
import { calendarDateOf, daysBetween, type CalendarDate } from "@/lib/dates";
import type { ScopedDb } from "@/lib/db/scoped";
import { valueDefinition, condition, type Condition } from "./schemas";
import type { OnboardingFacts, OnboardingPlanFacts } from "./stall";
import { timeToValue, type TtvPeer } from "./ttv";
import type { UsageData } from "./value";

/**
 * Set-based loading for open onboarding plans (no per-account queries): the plans with their steps
 * and template, the accounts, their usage and feature rows since the earliest plan start, key
 * features of their plans, seats on the current contract, and completed plans in the workspace as
 * cohort peers for time to value. One query when no account in the set has an open plan.
 */

/** M3's minimum cohort size (DEFAULT_MODEL.params.cohortMinPeers), reused for time to value. */
export const TTV_MIN_PEERS = 5;

type PlanRow = OnboardingPlan & { steps: OnboardingStep[]; template: OnboardingTemplate | null };

export interface PlanContext {
  plan: PlanRow;
  account: {
    id: string;
    tier: "HIGH_TOUCH" | "MID_TOUCH" | "LONG_TAIL";
    plan: string | null;
    employeeBand: string | null;
    useCase: string | null;
  };
  data: UsageData;
  keyFeatures: Array<{ featureKey: string; label: string }>;
  valueDefinition: Condition[];
  peers: TtvPeer[];
}

const d = (x: Date) => calendarDateOf(x);

export async function loadPlanContexts(
  db: ScopedDb,
  accountIds: string[],
  asOf: CalendarDate,
  /** Specific plans, whatever their status (Account 360 shows a completed plan's TTV). */
  planIds?: string[],
): Promise<Map<string, PlanContext>> {
  const out = new Map<string, PlanContext>();
  if (accountIds.length === 0) return out;
  const plans: PlanRow[] = await db.onboardingPlan.findMany({
    where: {
      accountId: { in: accountIds },
      ...(planIds ? { id: { in: planIds } } : { status: { in: ["ACTIVE", "STALLED"] } }),
    },
    include: { steps: { orderBy: { position: "asc" } }, template: true },
  });
  if (plans.length === 0) return out;
  const ids = plans.map((p) => p.accountId);
  const from = new Date(Math.min(...plans.map((p) => p.startDate.getTime())));
  const asOfDate = new Date(`${asOf}T00:00:00Z`);
  const [accounts, usage, features, catalog, contracts, completed] = await Promise.all([
    db.account.findMany({
      where: { id: { in: ids } },
      select: { id: true, tier: true, plan: true, employeeBand: true, useCase: true },
    }),
    db.usageDaily.findMany({
      where: { accountId: { in: ids }, date: { gte: from, lte: asOfDate } },
      select: { id: true, accountId: true, date: true, activeUsers: true },
    }),
    db.featureUsageDaily.findMany({
      where: { accountId: { in: ids }, date: { gte: from, lte: asOfDate } },
      select: { id: true, accountId: true, featureKey: true, date: true, users: true },
    }),
    db.featureCatalog.findMany({ where: { isKeyFeature: true } }),
    db.contract.findMany({
      where: { accountId: { in: ids }, status: "ACTIVE", startDate: { lte: asOfDate } },
      select: { accountId: true, startDate: true, seatsPurchased: true },
      orderBy: { startDate: "asc" },
    }),
    db.onboardingPlan.findMany({
      where: { status: "COMPLETE", valueReachedAt: { not: null, lte: asOfDate } },
      select: {
        id: true,
        startDate: true,
        valueReachedAt: true,
        account: {
          select: { id: true, tier: true, plan: true, employeeBand: true, useCase: true },
        },
      },
    }),
  ]);
  const peers: TtvPeer[] = completed.map((p) => ({
    ...p.account,
    planId: p.id,
    ttvDays: daysBetween(d(p.startDate), d(p.valueReachedAt!)),
  }));
  const seats = new Map<string, number | null>();
  for (const c of contracts) seats.set(c.accountId, c.seatsPurchased); // latest start wins
  const byAccount = new Map(accounts.map((a) => [a.id, a]));
  for (const plan of plans) {
    const account = byAccount.get(plan.accountId);
    if (!account) continue;
    const keyFeatures = catalog
      .filter((f) => account.plan !== null && f.includedInPlans.includes(account.plan))
      .map((f) => ({ featureKey: f.featureKey, label: f.label }));
    const def = valueDefinition.safeParse(plan.template?.valueDefinition ?? []);
    out.set(plan.accountId, {
      plan,
      account,
      keyFeatures,
      valueDefinition: def.success ? def.data : [],
      peers,
      data: {
        usage: usage
          .filter((u) => u.accountId === plan.accountId)
          .map((u) => ({ id: u.id, date: d(u.date), activeUsers: u.activeUsers })),
        featureUsage: features
          .filter((f) => f.accountId === plan.accountId)
          .map((f) => ({ id: f.id, featureKey: f.featureKey, date: d(f.date), users: f.users })),
        keyFeatures: keyFeatures.map((k) => k.featureKey),
        seatsPurchased: seats.get(plan.accountId) ?? null,
      },
    });
  }
  return out;
}

/** A step's own product condition, if its template gave it one (D1). */
export function stepCondition(step: OnboardingStep): Condition | null {
  const c = condition.safeParse(step.completesWhen);
  return c.success ? c.data : null;
}

/**
 * The facts stall.ts and the signal rules read. Usage that does not exist reads as null (no data
 * source) so it can never create a stall (Rule 4).
 */
export function factsOf(
  c: PlanContext,
  asOf: CalendarDate,
): { plan: OnboardingPlanFacts; facts: OnboardingFacts } {
  const start = d(c.plan.startDate);
  const valueReachedAt = c.plan.valueReachedAt ? d(c.plan.valueReachedAt) : null;
  const ttv = timeToValue({
    me: c.account,
    asOf,
    startDate: start,
    // The plan's own target (set from the template, adjustable per account) comes first (D3).
    targetDays: daysBetween(start, d(c.plan.targetValueDate)),
    hasValueDefinition: c.valueDefinition.length > 0,
    valueReachedAt,
    valueEvidence: Array.isArray(c.plan.valueEvidence) ? (c.plan.valueEvidence as never) : [],
    peers: c.peers.filter((p) => p.id !== c.account.id),
    minPeers: TTV_MIN_PEERS,
  });
  const plan: OnboardingPlanFacts = {
    planId: c.plan.id,
    startDate: start,
    valueReachedAt,
    steps: c.plan.steps.map((s) => ({
      id: s.id,
      title: s.title,
      ownerSide: s.ownerSide,
      dueDate: d(s.dueDate),
      doneDate: s.doneAt ? d(s.doneAt) : null,
      blockedReason: s.blockedReason,
    })),
    ttv,
  };
  return {
    plan,
    facts: {
      ...plan,
      asOf,
      usage: c.data.usage.length ? c.data.usage : null,
      featureUsage: c.data.featureUsage.length ? c.data.featureUsage : null,
      keyFeatures: c.keyFeatures,
    },
  };
}

/** For the signal bundle: each account's open plan facts (signals lifecycle, real-time hook). */
export async function onboardingFactsFor(
  db: ScopedDb,
  accountIds: string[],
  asOf: CalendarDate,
): Promise<Map<string, OnboardingPlanFacts>> {
  const contexts = await loadPlanContexts(db, accountIds, asOf);
  return new Map([...contexts].map(([id, c]) => [id, factsOf(c, asOf).plan]));
}
