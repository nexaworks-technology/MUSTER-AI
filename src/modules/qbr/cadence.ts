import { addDays, calendarDateOf, daysBetween, startOfLocalDay, utcMidnight } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { writeOutboxEvent } from "@/lib/jobs/outbox";
import { loadContext } from "@/modules/health/service";

/**
 * Nightly cadence detector for QBRs (M10, Decision 4).
 * Emits `qbr.due` when an account reaches >= 90 days since its last completed/locked QBR
 * or since contract start.
 * Set-based across the chunk accounts (no N+1).
 */
export async function syncQbrDue(
  ctx: TenantContext,
  accountIds: string[],
  asOf: string,
): Promise<{ checked: number; due: number }> {
  if (accountIds.length === 0) return { checked: 0, due: 0 };
  const db = scopedDb(ctx);
  const hctx = await loadContext(ctx);
  const asOfDay = utcMidnight(asOf);
  const dayEnd = startOfLocalDay(addDays(asOf, 1), hctx.timeZone);

  // 1. Contracts active on asOf
  const contracts = await db.contract.findMany({
    where: {
      accountId: { in: accountIds },
      startDate: { lte: asOfDay },
      status: "ACTIVE",
    },
    orderBy: { startDate: "desc" },
    select: { accountId: true, startDate: true },
  });

  // 2. Locked QBR documents as of asOf
  const lockedQbrs = await db.document.findMany({
    where: {
      accountId: { in: accountIds },
      kind: "QBR",
      lockedAt: { not: null, lt: dayEnd },
    },
    orderBy: { lockedAt: "desc" },
    select: { accountId: true, lockedAt: true },
  });

  // Group by account
  const contractByAcc = new Map<string, Date>();
  for (const c of contracts) {
    if (!contractByAcc.has(c.accountId)) contractByAcc.set(c.accountId, c.startDate);
  }

  const qbrByAcc = new Map<string, Date>();
  for (const d of lockedQbrs) {
    if (d.lockedAt && !qbrByAcc.has(d.accountId)) qbrByAcc.set(d.accountId, d.lockedAt);
  }

  let due = 0;
  await db.$tenantTransaction(async (tx) => {
    for (const accountId of accountIds) {
      const lastQbrDate = qbrByAcc.get(accountId);
      const contractStart = contractByAcc.get(accountId);
      const refDate = lastQbrDate ?? contractStart;
      if (!refDate) continue;

      const refCalendarDate = calendarDateOf(refDate);
      const days = daysBetween(refCalendarDate, asOf);

      if (days >= 90) {
        due++;
        await writeOutboxEvent(tx, {
          workspaceId: ctx.workspaceId,
          type: "qbr.due",
          payload: {
            workspaceId: ctx.workspaceId,
            accountId,
            daysSinceLastQbr: days,
            asOf,
          },
        });
      }
    }
  });

  return { checked: accountIds.length, due };
}
