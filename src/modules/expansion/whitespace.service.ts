import { addDays, calendarDateOf, utcMidnight, type CalendarDate } from "@/lib/dates";
import type { ScopedDb } from "@/lib/db/scoped";
import { whitespace, type Whitespace } from "./whitespace";

const SEAT_DAYS = 28;
const FEATURE_DAYS = 90;

/**
 * Whitespace for a set of accounts as of a date: unused plan features and seat headroom, from the
 * accounts' own records, in a fixed number of reads whatever the number of accounts. No money.
 */
export async function loadWhitespace(
  db: ScopedDb,
  accountIds: string[],
  asOf: CalendarDate,
): Promise<Map<string, Whitespace>> {
  const out = new Map<string, Whitespace>();
  if (accountIds.length === 0) return out;
  const day = utcMidnight(asOf);
  const [accounts, catalog, contracts, features, people, usage] = await Promise.all([
    db.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, plan: true } }),
    db.featureCatalog.findMany({
      where: { isKeyFeature: true },
      select: { featureKey: true, label: true, includedInPlans: true },
      orderBy: { featureKey: "asc" },
    }),
    db.contract.findMany({
      where: { accountId: { in: accountIds }, status: "ACTIVE", startDate: { lte: day } },
      select: { accountId: true, startDate: true, seatsPurchased: true },
    }),
    db.featureUsageDaily.groupBy({
      by: ["accountId", "featureKey"],
      where: {
        accountId: { in: accountIds },
        users: { gt: 0 },
        date: { gte: utcMidnight(addDays(asOf, -FEATURE_DAYS)), lt: day },
      },
      _max: { date: true },
    }),
    db.userUsageDaily.groupBy({
      by: ["accountId", "externalUserId"],
      where: {
        accountId: { in: accountIds },
        events: { gt: 0 },
        date: { gte: utcMidnight(addDays(asOf, -SEAT_DAYS)), lt: day },
      },
    }),
    db.usageDaily.findMany({
      where: {
        accountId: { in: accountIds },
        seatsUsed: { not: null },
        date: { gte: utcMidnight(addDays(asOf, -SEAT_DAYS)), lt: day },
      },
      select: { accountId: true, date: true, seatsUsed: true },
      orderBy: { date: "asc" },
    }),
  ]);
  for (const a of accounts) {
    const contract = contracts
      .filter((c) => c.accountId === a.id)
      .sort((x, y) => y.startDate.getTime() - x.startDate.getTime())[0];
    const users = new Set(people.filter((p) => p.accountId === a.id).map((p) => p.externalUserId));
    const fallback = usage.filter((u) => u.accountId === a.id).at(-1)?.seatsUsed ?? null;
    const featureRows = features.filter((f) => f.accountId === a.id);
    const anyFeatureData = featureRows.length > 0;
    out.set(
      a.id,
      whitespace({
        asOf,
        plan: a.plan,
        catalog,
        featureUsage: anyFeatureData
          ? featureRows.map((f) => ({
              featureKey: f.featureKey,
              lastUsed: calendarDateOf(f._max.date!),
            }))
          : null,
        seatsPurchased: contract?.seatsPurchased ?? null,
        seatsInUse: users.size > 0 ? users.size : fallback,
      }),
    );
  }
  return out;
}
