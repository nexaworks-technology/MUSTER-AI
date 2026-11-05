import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { addDays, calendarDateOf, utcMidnight, type CalendarDate } from "@/lib/dates";
import type { ScopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import {
  getActiveModel,
  liveSnapshotWhere,
  loadBundles,
  type Band,
} from "@/modules/health/service";
import { onboardingFactsFor } from "@/modules/onboarding/service";
import type { AdoptionInput } from "@/modules/usage/service";
import { adoptionReport } from "./adoption";
import { expansionFoundReport } from "./expansion-found";
import { onboardingTtvReport } from "./onboarding-ttv";
import { portfolioHealthTrend } from "./portfolio-health-trend";
import { renewalOutcomesReport } from "./renewal-outcomes";
import { supportRiskReport } from "./support-risk";
import { teamActivityReport } from "./team-activity";
import type { ReportContent, ReportKey } from "./types";

/**
 * Loads the records each report reads, in a fixed number of set-based queries whatever the
 * number of accounts (no N+1), through the tenant-scoped client, always restricted to the
 * account ids the viewer's book and filters allow. Then hands them to the pure computation.
 */
export interface ScopeAccount {
  id: string;
  name: string;
  tier: "HIGH_TOUCH" | "MID_TOUCH" | "LONG_TAIL";
  lifecycleStage: "ONBOARDING" | "ADOPTING" | "MATURE" | "RENEWING" | "LOST";
  plan: string | null;
  ownerMembershipId: string | null;
  arrMinor: bigint | null;
  arrCurrency: string | null;
  currentHealth: {
    id: string;
    healthModelId: string;
    riskLevel: Band;
  } | null;
}

export interface Scope {
  actor: Actor;
  db: ScopedDb;
  accounts: ScopeAccount[];
  ids: string[];
  start: CalendarDate;
  end: CalendarDate;
  today: CalendarDate;
  baseCurrency: string;
  timeZone: string;
  /** Query string carried into links to list screens (tier, owner, segment). */
  query: string;
}

const day = (d: CalendarDate) => utcMidnight(d);
const dayAfter = (d: CalendarDate) => utcMidnight(addDays(d, 1));
const none = (ids: string[]) => ids.length === 0;

async function healthReport(s: Scope): Promise<ReportContent> {
  const model = await getActiveModel(s.actor);
  const accounts = s.accounts.filter((a) => a.lifecycleStage !== "LOST");
  const ids = accounts.map((a) => a.id);
  const snaps = none(ids)
    ? []
    : await s.db.healthScoreSnapshot.findMany({
        where: liveSnapshotWhere({
          accountId: { in: ids },
          healthModelId: model.id,
          asOf: { gte: day(addDays(s.start, -7)), lte: day(s.end) },
        }),
        select: { id: true, accountId: true, asOf: true, riskLevel: true },
      });
  return portfolioHealthTrend({
    periodStart: s.start,
    periodEnd: s.end,
    baseCurrency: s.baseCurrency,
    query: s.query,
    accounts: accounts.map((a) => {
      const h = a.currentHealth?.healthModelId === model.id ? a.currentHealth : null;
      return {
        id: a.id,
        arrMinor: a.arrMinor,
        currency: a.arrCurrency,
        currentSnapshotId: h?.id ?? null,
        currentRisk: h?.riskLevel ?? null,
      };
    }),
    snapshots: snaps.map((x) => ({
      id: x.id,
      accountId: x.accountId,
      asOf: calendarDateOf(x.asOf),
      riskLevel: x.riskLevel,
    })),
  });
}

async function adoptionData(s: Scope): Promise<ReportContent> {
  const accounts = s.accounts.filter((a) => a.lifecycleStage !== "LOST");
  const ids = accounts.map((a) => a.id);
  if (none(ids)) return adoptionReport([], s.query);
  const asOf = s.today;
  const lc = {
    workspaceId: s.actor.workspaceId,
    timeZone: s.timeZone,
    baseCurrency: s.baseCurrency,
  };
  const [bundles, catalog, contracts, usage] = await Promise.all([
    loadBundles(s.db, lc, asOf, ids),
    s.db.featureCatalog.findMany({ orderBy: { label: "asc" } }),
    s.db.contract.findMany({
      where: { accountId: { in: ids }, status: "ACTIVE", startDate: { lte: day(asOf) } },
      orderBy: { startDate: "desc" },
    }),
    s.db.usageDaily.findMany({
      where: { accountId: { in: ids }, date: { gte: day(addDays(asOf, -120)), lte: day(asOf) } },
      orderBy: { date: "asc" },
      select: {
        id: true,
        accountId: true,
        date: true,
        activeUsers: true,
        seatsUsed: true,
        creditsUsed: true,
      },
    }),
  ]);
  const inputs: AdoptionInput[] = accounts.map((a) => {
    const b = bundles.get(a.id);
    const c = contracts.find((x) => x.accountId === a.id); // latest start first
    const rows = usage.filter((u) => u.accountId === a.id);
    return {
      accountId: a.id,
      asOf,
      plan: a.plan,
      contract: c
        ? {
            id: c.id,
            seatsPurchased: c.seatsPurchased,
            creditsPurchased: c.creditsPurchased,
            startDate: calendarDateOf(c.startDate),
          }
        : null,
      usage: rows.length
        ? rows.map((r) => ({
            id: r.id,
            date: calendarDateOf(r.date),
            activeUsers: r.activeUsers,
            seatsUsed: r.seatsUsed,
            creditsUsed: r.creditsUsed,
          }))
        : null,
      userUsage: b?.userUsage ?? null,
      featureUsage: b?.featureUsage ?? null,
      catalog,
      ownNormal: b?.ownBaseline
        ? { median: b.ownBaseline.median, from: b.ownBaseline.from, to: b.ownBaseline.to }
        : null,
      cohort: b?.cohort ?? null,
    };
  });
  return adoptionReport(inputs, s.query);
}

async function onboardingData(s: Scope): Promise<ReportContent> {
  const ids = s.ids;
  if (none(ids)) return onboardingTtvReport({ completed: [], open: [], query: s.query });
  const [done, open] = await Promise.all([
    s.db.onboardingPlan.findMany({
      where: {
        accountId: { in: ids },
        status: "COMPLETE",
        valueReachedAt: { gte: day(s.start), lt: dayAfter(s.end) },
      },
      select: {
        id: true,
        accountId: true,
        startDate: true,
        valueReachedAt: true,
        targetValueDate: true,
      },
      orderBy: [{ valueReachedAt: "asc" }, { id: "asc" }],
    }),
    onboardingFactsFor(s.db, ids, s.today),
  ]);
  return onboardingTtvReport({
    completed: done.map((p) => ({
      planId: p.id,
      accountId: p.accountId,
      startDate: calendarDateOf(p.startDate),
      valueReachedAt: calendarDateOf(p.valueReachedAt!),
      targetValueDate: calendarDateOf(p.targetValueDate),
    })),
    open: [...open].map(([accountId, f]) => ({ planId: f.planId, accountId, ttv: f.ttv })),
    query: s.query,
  });
}

export const UPCOMING_DAYS = 90;
const OPEN_STAGES = ["UPCOMING", "IN_PROGRESS"] as const;

async function renewalsData(s: Scope): Promise<ReportContent> {
  const ids = s.ids;
  const upcomingWhere = {
    accountId: { in: ids },
    stage: { in: [...OPEN_STAGES] },
    renewalDate: { gte: day(s.today), lte: day(addDays(s.today, UPCOMING_DAYS)) },
  } satisfies Prisma.RenewalWhereInput;
  const [inPeriod, upcoming] = none(ids)
    ? [[], []]
    : await Promise.all([
        s.db.renewalOutcome.findMany({
          where: { accountId: { in: ids }, occurredOn: { gte: day(s.start), lte: day(s.end) } },
          orderBy: [{ occurredOn: "asc" }, { id: "asc" }],
        }),
        s.db.renewal.findMany({
          where: upcomingWhere,
          select: {
            id: true,
            accountId: true,
            arrAtRiskMinor: true,
            currency: true,
            confidenceBand: true,
            forecastCategory: true,
          },
          orderBy: { id: "asc" },
        }),
      ]);
  // A correction made after the period still replaces the row it corrects.
  const lateFixes = inPeriod.length
    ? await s.db.renewalOutcome.findMany({
        where: { supersedesId: { in: inPeriod.map((o) => o.id) } },
        select: { supersedesId: true },
      })
    : [];
  const replaced = new Set(lateFixes.flatMap((f) => (f.supersedesId ? [f.supersedesId] : [])));
  return renewalOutcomesReport({
    baseCurrency: s.baseCurrency,
    query: s.query,
    upcomingDays: UPCOMING_DAYS,
    outcomes: inPeriod
      .filter((o) => !replaced.has(o.id))
      .map((o) => ({
        id: o.id,
        accountId: o.accountId,
        renewalId: o.renewalId,
        result: o.result,
        occurredOn: calendarDateOf(o.occurredOn),
        outcomeArrMinor: o.outcomeArrMinor,
        currency: o.currency,
        forecastBand: o.forecastBand,
        forecastArrAtRiskMinor: o.forecastArrAtRiskMinor,
        supersedesId: o.supersedesId,
      })),
    upcoming: upcoming.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      arrMinor: r.arrAtRiskMinor,
      currency: r.currency,
      band: r.confidenceBand,
      category: r.forecastCategory,
    })),
  });
}

async function expansionData(s: Scope): Promise<ReportContent> {
  const rows = none(s.ids)
    ? []
    : await s.db.expansionOpportunity.findMany({
        where: {
          accountId: { in: s.ids },
          createdAt: { gte: day(s.start), lt: dayAfter(s.end) },
        },
        select: { id: true, accountId: true, status: true, estimateMinor: true, currency: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
  return expansionFoundReport({
    baseCurrency: s.baseCurrency,
    query: s.query,
    opportunities: rows,
  });
}

async function supportData(s: Scope): Promise<ReportContent> {
  const [tickets, signals] = none(s.ids)
    ? [[], []]
    : await Promise.all([
        s.db.ticket.findMany({
          where: {
            accountId: { in: s.ids },
            OR: [
              { status: { in: ["OPEN", "PENDING"] } },
              { openedAt: { gte: day(s.start), lt: dayAfter(s.end) } },
            ],
          },
          select: {
            id: true,
            accountId: true,
            status: true,
            priority: true,
            isEscalated: true,
            openedAt: true,
            firstResponseAt: true,
          },
          orderBy: [{ openedAt: "asc" }, { id: "asc" }],
        }),
        s.db.signal.findMany({
          where: {
            accountId: { in: s.ids },
            category: "SUPPORT",
            status: { in: ["OPEN", "ACKNOWLEDGED"] },
          },
          select: { id: true, accountId: true },
          orderBy: { id: "asc" },
        }),
      ]);
  return supportRiskReport({
    periodStart: s.start,
    periodEnd: s.end,
    query: s.query,
    tickets,
    signals,
  });
}

const d90 = z.object({ status: z.string() });

async function teamData(s: Scope): Promise<ReportContent> {
  const ids = s.ids;
  const [members, openTasks, doneTasks, approvals, flags] = none(ids)
    ? [[], [], [], [], []]
    : await Promise.all([
        s.db.membership.findMany({
          where: { status: "ACTIVE" },
          select: { id: true, user: { select: { name: true, email: true } } },
        }),
        s.db.task.findMany({
          where: { accountId: { in: ids }, status: "OPEN", ownerMembershipId: { not: null } },
          select: { id: true, accountId: true, ownerMembershipId: true },
          orderBy: { id: "asc" },
        }),
        s.db.task.findMany({
          where: {
            accountId: { in: ids },
            status: "DONE",
            ownerMembershipId: { not: null },
            completedAt: { gte: day(s.start), lt: dayAfter(s.end) },
          },
          select: { id: true, accountId: true, ownerMembershipId: true },
          orderBy: { id: "asc" },
        }),
        s.db.approval.findMany({
          where: {
            accountId: { in: ids },
            status: { in: ["APPROVED", "EDITED_APPROVED", "REJECTED"] },
            decidedById: { not: null },
            decidedAt: { gte: day(s.start), lt: dayAfter(s.end) },
          },
          select: { id: true, accountId: true, decidedById: true },
          orderBy: { id: "asc" },
        }),
        s.db.outcomeRecord.findMany({
          where: {
            accountId: { in: ids },
            flaggedAt: { gte: day(s.start), lt: dayAfter(s.end) },
          },
          select: { id: true, accountId: true, d90Outcome: true },
          orderBy: { id: "asc" },
        }),
      ]);
  return teamActivityReport({
    baseCurrency: s.baseCurrency,
    query: s.query,
    members: members.map((m) => ({ id: m.id, name: m.user.name ?? m.user.email })),
    accounts: s.accounts.map((a) => ({
      id: a.id,
      ownerMembershipId: a.ownerMembershipId,
      arrMinor: a.arrMinor,
      currency: a.arrCurrency,
    })),
    openTasks: openTasks.map((t) => ({ ...t, ownerMembershipId: t.ownerMembershipId! })),
    doneTasks: doneTasks.map((t) => ({ ...t, ownerMembershipId: t.ownerMembershipId! })),
    decidedApprovals: approvals.map((a) => ({ ...a, decidedById: a.decidedById! })),
    outcomes: flags.map((f) => ({
      id: f.id,
      accountId: f.accountId,
      d90Status: d90.safeParse(f.d90Outcome).data?.status ?? null,
    })),
  });
}

const LOADERS: Record<ReportKey, (s: Scope) => Promise<ReportContent>> = {
  "portfolio-health-trend": healthReport,
  adoption: adoptionData,
  "onboarding-ttv": onboardingData,
  "renewal-outcomes": renewalsData,
  "expansion-found": expansionData,
  "support-risk": supportData,
  "team-activity": teamData,
};

export const computeReport = (key: ReportKey, scope: Scope) => LOADERS[key](scope);
