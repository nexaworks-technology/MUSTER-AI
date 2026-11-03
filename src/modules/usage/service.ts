import { Prisma } from "@prisma/client";
import { scopedDb, type ScopedDb, type TenantContext } from "@/lib/db/scoped";
import type { TimelineItem } from "@/modules/accounts/schemas";
import { AccountNotFoundError, getAccount, type Actor } from "@/modules/accounts/service";
import {
  addDays,
  businessClock,
  calendarDateOf,
  todayIn,
  utcMidnight,
  type CalendarDate,
  type Clock,
} from "@/lib/dates";
import { loadBundles, loadContext } from "@/modules/health/service";
import { adoption } from "./adoption";
import { usageChangePoints } from "./change-points";
export { adoption, UNDER_USE_SHARE, type Adoption, type AdoptionInput } from "./adoption";

/**
 * Usage read model for Account 360 (spec §6G4 in CS language). Windows are computed with SQL
 * aggregates over daily rows — never per-row loops. Everything shown comes from real rows; with
 * no rows the caller shows an honest empty state (Rule 6).
 */
const DAY = 86_400_000;

export interface WeeklyPoint {
  weekStart: Date;
  /** Distinct people active in the week (user-level data), else the week's peak daily actives. */
  activeUsers: number;
}

export interface UsageView {
  hasData: boolean;
  metric: "distinct-users" | "peak-daily";
  weekly: WeeklyPoint[];
  lastActiveDate: Date | null;
  /** The window people, seats and features are counted over; null = the last 28 days to now. */
  period: { from: CalendarDate; to: CalendarDate } | null;
  activeUsers28d: number | null;
  seatsPurchased: number | null;
  features: Array<{
    key: string;
    label: string;
    isKey: boolean;
    inPlan: boolean;
    daysUsed28d: number;
    lastUsed: Date | null;
  }>;
  topUsers: Array<{
    externalUserId: string;
    name: string | null;
    events: number;
    daysActive: number;
  }>;
}

export async function getUsage(
  actor: Actor,
  accountId: string,
  asOf = new Date(),
  window?: { from: CalendarDate; to: CalendarDate },
): Promise<UsageView> {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  const db = scopedDb(actor);
  const workspaceId = actor.workspaceId;
  const since91 = new Date(asOf.getTime() - 91 * DAY);
  // People, seats and features: a health reason's own window when it links here, both ends
  // included (lower bound exclusive by one day), else the last 28 days up to now.
  const periodAfter = window
    ? new Date(utcMidnight(window.from).getTime() - DAY)
    : new Date(asOf.getTime() - 28 * DAY);
  const until = window ? utcMidnight(window.to) : asOf;

  const [userWeeks, dailyWeeks, lastActive, active28, features, catalog, topUsers, contract] =
    await Promise.all([
      db.$queryRaw<Array<{ week: Date; n: bigint }>>(Prisma.sql`
      SELECT date_trunc('week', "date")::date AS week, count(DISTINCT "externalUserId") AS n
      FROM "UserUsageDaily"
      WHERE "workspaceId" = ${workspaceId} AND "accountId" = ${accountId} AND "date" > ${since91} AND "date" <= ${asOf}
      GROUP BY 1 ORDER BY 1`),
      db.$queryRaw<Array<{ week: Date; n: number }>>(Prisma.sql`
      SELECT date_trunc('week', "date")::date AS week, max("activeUsers") AS n
      FROM "UsageDaily"
      WHERE "workspaceId" = ${workspaceId} AND "accountId" = ${accountId} AND "date" > ${since91} AND "date" <= ${asOf}
      GROUP BY 1 ORDER BY 1`),
      db.usageDaily.findFirst({
        where: { accountId, activeUsers: { gt: 0 }, date: { lte: asOf } },
        orderBy: { date: "desc" },
        select: { date: true },
      }),
      db.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(DISTINCT "externalUserId") AS n FROM "UserUsageDaily"
      WHERE "workspaceId" = ${workspaceId} AND "accountId" = ${accountId} AND "date" > ${periodAfter} AND "date" <= ${until}`),
      db.featureUsageDaily.groupBy({
        by: ["featureKey"],
        where: { accountId, date: { gt: periodAfter, lte: until }, users: { gt: 0 } },
        _count: { _all: true },
        _max: { date: true },
      }),
      db.featureCatalog.findMany({ orderBy: { label: "asc" } }),
      db.$queryRaw<
        Array<{ externalUserId: string; contactName: string | null; events: bigint; days: bigint }>
      >(Prisma.sql`
      SELECT u."externalUserId", c."name" AS "contactName", sum(u."events") AS events, count(*) AS days
      FROM "UserUsageDaily" u
      LEFT JOIN "Contact" c ON c."workspaceId" = u."workspaceId" AND c."id" = u."contactId"
      WHERE u."workspaceId" = ${workspaceId} AND u."accountId" = ${accountId} AND u."date" > ${periodAfter} AND u."date" <= ${until}
      GROUP BY 1, 2 ORDER BY events DESC, 1 ASC LIMIT 10`),
      db.contract.findFirst({
        where: { accountId, status: "ACTIVE", startDate: { lte: until } },
        orderBy: { startDate: "desc" },
        select: { seatsPurchased: true },
      }),
    ]);

  const useUsers = userWeeks.length > 0;
  const weekly = (useUsers ? userWeeks : dailyWeeks).map((w) => ({
    weekStart: new Date(w.week),
    activeUsers: Number(w.n),
  }));
  const used = new Map(features.map((f) => [f.featureKey, f]));
  const plan = account.plan;
  return {
    hasData: weekly.length > 0 || lastActive !== null,
    metric: useUsers ? "distinct-users" : "peak-daily",
    weekly,
    lastActiveDate: lastActive?.date ?? null,
    period: window ?? null,
    activeUsers28d: useUsers ? Number(active28[0]?.n ?? 0) : null,
    seatsPurchased: contract?.seatsPurchased ?? null,
    features: catalog
      .filter((f) => used.has(f.featureKey) || (plan !== null && f.includedInPlans.includes(plan)))
      .map((f) => ({
        key: f.featureKey,
        label: f.label,
        isKey: f.isKeyFeature,
        inPlan: plan !== null && f.includedInPlans.includes(plan),
        daysUsed28d: used.get(f.featureKey)?._count._all ?? 0,
        lastUsed: used.get(f.featureKey)?._max.date ?? null,
      })),
    topUsers: topUsers.map((u) => ({
      externalUserId: u.externalUserId,
      name: u.contactName,
      events: Number(u.events),
      daysActive: Number(u.days),
    })),
  };
}

// ─── Timeline source ─────────────────────────────────────────────────────────

/** Usage change points over the last year (one SQL aggregate + the pure detector). */
export async function usageTimeline(
  db: ScopedDb,
  workspaceId: string,
  accountId: string,
  upTo: Date,
): Promise<TimelineItem[]> {
  const since = new Date(upTo.getTime() - 371 * DAY);
  const rows = await db.$queryRaw<Array<{ week: Date; avg: number }>>(Prisma.sql`
    SELECT date_trunc('week', "date")::date AS week, avg("activeUsers")::float AS avg
    FROM "UsageDaily"
    WHERE "workspaceId" = ${workspaceId} AND "accountId" = ${accountId} AND "date" > ${since} AND "date" <= ${upTo}
    GROUP BY 1 ORDER BY 1`);
  return usageChangePoints(
    rows.map((r) => ({ weekStart: new Date(r.week), avgActive: Number(r.avg) })),
  ).map((p) => {
    const at = new Date(p.weekStart.getTime() + 6 * DAY);
    return {
      key: `usage:${p.weekStart.toISOString().slice(0, 10)}`,
      at: at > upTo ? upTo : at,
      kind: "usage" as const,
      title: `Usage ${p.direction === "down" ? "fell" : "rose"} ${p.pct}% against the previous four weeks`,
      detail: `Average daily active users ${p.value} vs ${p.baseline} before (week of ${p.weekStart.toISOString().slice(0, 10)}).`,
      href: `/accounts/${accountId}/usage`,
      sourceType: "UsageDaily",
      sourceId: `${accountId}:${p.weekStart.toISOString().slice(0, 10)}`,
    };
  });
}

// ─── Adoption (M6, spec §6G4) ───────────────────────────────────────────────

/**
 * The Adoption tab's figures for one account, as of the business date: the M3 bundle (own normal,
 * cohort, per-person and per-feature rows), the plan's full feature catalogue, the current
 * contract and daily seats/credits. Book scope applies (getAccount).
 */
export async function getAdoption(actor: Actor, accountId: string, clock: Clock = businessClock) {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  return loadAdoption(actor, accountId, clock);
}

/**
 * The same figures for a background job (the Adoption Coach): no member, so no book check; the
 * workspace scope still applies to every read. The caller has already decided the account is its own.
 */
export async function loadAdoption(
  ctx: TenantContext,
  accountId: string,
  clock: Clock = businessClock,
) {
  const db = scopedDb(ctx);
  const lc = await loadContext(ctx);
  const asOf = todayIn(lc.timeZone, clock);
  const [bundles, catalog, contracts, rows, plan] = await Promise.all([
    loadBundles(db, lc, asOf, [accountId]),
    db.featureCatalog.findMany({ orderBy: { label: "asc" } }),
    db.contract.findMany({
      where: { accountId, status: "ACTIVE", startDate: { lte: utcMidnight(asOf) } },
      orderBy: { startDate: "desc" },
      take: 1,
    }),
    db.usageDaily.findMany({
      where: { accountId, date: { gte: utcMidnight(addDays(asOf, -120)), lte: utcMidnight(asOf) } },
      orderBy: { date: "asc" },
      select: { id: true, date: true, activeUsers: true, seatsUsed: true, creditsUsed: true },
    }),
    db.account.findUniqueOrThrow({ where: { id: accountId }, select: { plan: true } }),
  ]);
  const b = bundles.get(accountId);
  const c = contracts[0];
  return {
    asOf,
    ...adoption({
      accountId,
      asOf,
      plan: plan.plan,
      contract: c
        ? {
            id: c.id,
            seatsPurchased: c.seatsPurchased,
            creditsPurchased: c.creditsPurchased,
            startDate: calendarDateOf(c.startDate),
          }
        : null,
      usage: rows.length ? rows.map((r) => ({ ...r, date: calendarDateOf(r.date) })) : null,
      userUsage: b?.userUsage ?? null,
      featureUsage: b?.featureUsage ?? null,
      catalog,
      ownNormal: b?.ownBaseline
        ? { median: b.ownBaseline.median, from: b.ownBaseline.from, to: b.ownBaseline.to }
        : null,
      cohort: b?.cohort ?? null,
    }),
  };
}
