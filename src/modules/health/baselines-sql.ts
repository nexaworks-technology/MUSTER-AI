import { Prisma } from "@prisma/client";
import { addDays, calendarDateOf, type CalendarDate } from "@/lib/dates";
import type { ScopedDb } from "@/lib/db/scoped";
import type { OwnBaseline } from "./engine/types";

/**
 * Set-based baselines for a chunk of accounts (ARCHITECTURE §4.2, §11: no N+1). They compute
 * exactly what engine/baselines.ts and engine/windows.ts compute; baselines.int.test.ts proves
 * it on generated data. Every query filters by workspace (D-40) on top of RLS.
 */

/** Own normal: 13 weekly "typical weekday" values (avg of the 5 busiest of 7 days). */
export async function ownBaselinesSql(
  db: ScopedDb,
  workspaceId: string,
  asOf: CalendarDate,
  accountIds: string[],
): Promise<Map<string, OwnBaseline>> {
  const from = addDays(asOf, -104);
  const to = addDays(asOf, -14);
  if (accountIds.length === 0) return new Map();
  const rows = await db.$queryRaw<
    Array<{ id: string; median: number | null; p25: number | null; historyDays: number }>
  >(Prisma.sql`
    WITH accts AS (SELECT unnest(${accountIds}::text[]) AS id),
    first_day AS (
      SELECT "accountId", min(date) AS d FROM "UsageDaily"
      WHERE "workspaceId" = ${workspaceId} AND "accountId" = ANY(${accountIds}) AND date <= ${to}::date
      GROUP BY 1
    ),
    weeks AS (
      SELECT f."accountId", k, (${to}::date - 7 * k) AS week_end
      FROM first_day f, generate_series(0, 12) AS k
      WHERE (${to}::date - 7 * k - 6) >= f.d
    ),
    vals AS (
      SELECT w."accountId", w.k, COALESCE(u."activeUsers", 0) AS v
      FROM weeks w
      CROSS JOIN generate_series(0, 6) AS g
      LEFT JOIN "UsageDaily" u
        ON u."workspaceId" = ${workspaceId} AND u."accountId" = w."accountId"
        AND u.date = (w.week_end - g)
    ),
    ranked AS (
      SELECT "accountId", k, v, row_number() OVER (PARTITION BY "accountId", k ORDER BY v DESC) AS rn
      FROM vals
    ),
    weekly AS (
      SELECT "accountId", k, avg(v)::float8 AS value FROM ranked WHERE rn <= 5 GROUP BY 1, 2
    ),
    hist AS (
      SELECT "accountId", count(DISTINCT date)::int AS n FROM "UsageDaily"
      WHERE "workspaceId" = ${workspaceId} AND "accountId" = ANY(${accountIds})
        AND date BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1
    )
    SELECT a.id,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY w.value) AS median,
      percentile_cont(0.25) WITHIN GROUP (ORDER BY w.value) AS p25,
      COALESCE(max(h.n), 0)::int AS "historyDays"
    FROM accts a
    LEFT JOIN weekly w ON w."accountId" = a.id
    LEFT JOIN hist h ON h."accountId" = a.id
    GROUP BY a.id`);
  return new Map(
    rows.map((r) => [r.id, { median: r.median, p25: r.p25, historyDays: r.historyDays, from, to }]),
  );
}

/** Current "typical weekday" value for accounts whose usage is fresh (ends within staleDays of yesterday). */
export async function currentUsageSql(
  db: ScopedDb,
  workspaceId: string,
  asOf: CalendarDate,
  staleDays: number,
  accountIds?: string[],
): Promise<Map<string, { value: number; from: CalendarDate; to: CalendarDate }>> {
  const yesterday = addDays(asOf, -1);
  const scope = accountIds ? Prisma.sql`AND "accountId" = ANY(${accountIds})` : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ accountId: string; to: Date; value: number }>>(Prisma.sql`
    WITH last AS (
      SELECT "accountId", max(date) AS d FROM "UsageDaily"
      WHERE "workspaceId" = ${workspaceId} AND date <= ${yesterday}::date ${scope}
      GROUP BY 1
      HAVING max(date) >= (${yesterday}::date - ${staleDays}::int)
    ),
    vals AS (
      SELECT l."accountId", l.d, COALESCE(u."activeUsers", 0) AS v
      FROM last l
      CROSS JOIN generate_series(0, 6) AS g
      LEFT JOIN "UsageDaily" u
        ON u."workspaceId" = ${workspaceId} AND u."accountId" = l."accountId" AND u.date = (l.d - g)
    ),
    ranked AS (
      SELECT "accountId", d, v, row_number() OVER (PARTITION BY "accountId" ORDER BY v DESC) AS rn
      FROM vals
    )
    SELECT "accountId", d AS "to", avg(v)::float8 AS value FROM ranked WHERE rn <= 5 GROUP BY 1, 2`);
  return new Map(
    rows.map((r) => {
      const to = calendarDateOf(r.to);
      return [r.accountId, { value: r.value, from: addDays(to, -6), to }];
    }),
  );
}
