import { calendarDateOf, addDays, utcMidnight, type CalendarDate } from "@/lib/dates";
import type { ScopedDb } from "@/lib/db/scoped";
import type { SignalBundle } from "./rules";

type Facts = NonNullable<SignalBundle["expansion"]>;

/**
 * M7 B1: the expansion rules' extra inputs for a chunk of accounts, as of a date, in a fixed number
 * of set-based reads (§11): first-seen dates and contact emails, credits purchased and used, and
 * the open goals whose measure is explicitly seats or users (D7: every other goal is ignored until
 * M9). Everything is cut at the as-of date.
 */
export async function loadExpansionFacts(
  db: ScopedDb,
  asOf: CalendarDate,
  accountIds: string[],
  contractByAccount: Map<string, string>,
): Promise<Map<string, Facts>> {
  const out = new Map<string, Facts>();
  if (accountIds.length === 0) return out;
  const asOfDay = utcMidnight(asOf);
  const [first, contracts, usage, goals] = await Promise.all([
    db.userUsageDaily.groupBy({
      by: ["accountId", "externalUserId"],
      where: { accountId: { in: accountIds }, date: { lte: asOfDay } },
      _min: { date: true },
      _max: { contactId: true },
    }),
    db.contract.findMany({
      where: { id: { in: [...contractByAccount.values()] } },
      select: { id: true, creditsPurchased: true },
    }),
    db.usageDaily.findMany({
      where: {
        accountId: { in: accountIds },
        date: { gte: utcMidnight(addDays(asOf, -28)), lt: asOfDay },
        creditsUsed: { not: null },
      },
      select: { id: true, accountId: true, date: true, creditsUsed: true },
      orderBy: [{ date: "asc" }, { id: "asc" }],
    }),
    db.goal.findMany({
      where: {
        accountId: { in: accountIds },
        status: "OPEN",
        metricKey: { in: ["seats", "users"] },
      },
      select: { id: true, accountId: true, text: true, metricKey: true, targetValue: true },
      orderBy: { id: "asc" },
    }),
  ]);
  const contactIds = [
    ...new Set(first.map((f) => f._max.contactId).filter((x): x is string => !!x)),
  ];
  // Always run (even with no ids) so the number of reads per chunk is fixed (§11).
  const contacts = await db.contact.findMany({
    where: { id: { in: contactIds } },
    select: { id: true, email: true },
  });
  const emailOf = new Map(contacts.map((c) => [c.id, c.email]));
  const credits = new Map(contracts.map((c) => [c.id, c.creditsPurchased]));

  for (const id of accountIds) {
    const rows = first.filter((f) => f.accountId === id && f._min.date);
    const lastUsage = usage.filter((u) => u.accountId === id).at(-1);
    const contractId = contractByAccount.get(id);
    const purchased = contractId ? credits.get(contractId) : null;
    out.set(id, {
      people: rows.length
        ? {
            historyFrom: calendarDateOf(
              rows.map((r) => r._min.date!).sort((a, b) => a.getTime() - b.getTime())[0]!,
            ),
            users: rows.map((r) => ({
              externalUserId: r.externalUserId,
              firstSeen: calendarDateOf(r._min.date!),
              contactId: r._max.contactId,
              email: r._max.contactId ? (emailOf.get(r._max.contactId) ?? null) : null,
            })),
          }
        : null,
      credits:
        lastUsage && lastUsage.creditsUsed !== null && purchased
          ? {
              purchased,
              used: lastUsage.creditsUsed,
              usedDate: calendarDateOf(lastUsage.date),
              usageRowId: lastUsage.id,
            }
          : null,
      goals: goals
        .filter((g) => g.accountId === id)
        .map((g) => ({
          id: g.id,
          text: g.text,
          metricKey: g.metricKey!,
          targetValue: g.targetValue,
        })),
    });
  }
  return out;
}
