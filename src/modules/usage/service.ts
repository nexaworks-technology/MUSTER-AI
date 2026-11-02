import { Prisma } from "@prisma/client";
import { scopedDb } from "@/lib/db/scoped";
import { AccountNotFoundError, getAccount, type Actor } from "@/modules/accounts/service";

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
): Promise<UsageView> {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const since91 = new Date(asOf.getTime() - 91 * DAY);
  const since28 = new Date(asOf.getTime() - 28 * DAY);

  const [userWeeks, dailyWeeks, lastActive, active28, features, catalog, topUsers, contract] =
    await Promise.all([
      db.$queryRaw<Array<{ week: Date; n: bigint }>>(Prisma.sql`
      SELECT date_trunc('week', "date")::date AS week, count(DISTINCT "externalUserId") AS n
      FROM "UserUsageDaily"
      WHERE "workspaceId" = ${ws} AND "accountId" = ${accountId} AND "date" > ${since91} AND "date" <= ${asOf}
      GROUP BY 1 ORDER BY 1`),
      db.$queryRaw<Array<{ week: Date; n: number }>>(Prisma.sql`
      SELECT date_trunc('week', "date")::date AS week, max("activeUsers") AS n
      FROM "UsageDaily"
      WHERE "workspaceId" = ${ws} AND "accountId" = ${accountId} AND "date" > ${since91} AND "date" <= ${asOf}
      GROUP BY 1 ORDER BY 1`),
      db.usageDaily.findFirst({
        where: { accountId, activeUsers: { gt: 0 }, date: { lte: asOf } },
        orderBy: { date: "desc" },
        select: { date: true },
      }),
      db.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT count(DISTINCT "externalUserId") AS n FROM "UserUsageDaily"
      WHERE "workspaceId" = ${ws} AND "accountId" = ${accountId} AND "date" > ${since28} AND "date" <= ${asOf}`),
      db.featureUsageDaily.groupBy({
        by: ["featureKey"],
        where: { accountId, date: { gt: since28, lte: asOf }, users: { gt: 0 } },
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
      WHERE u."workspaceId" = ${ws} AND u."accountId" = ${accountId} AND u."date" > ${since28} AND u."date" <= ${asOf}
      GROUP BY 1, 2 ORDER BY events DESC, 1 ASC LIMIT 10`),
      db.contract.findFirst({
        where: { accountId, status: "ACTIVE", startDate: { lte: asOf } },
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
