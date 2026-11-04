import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { calendarDateOf, type CalendarDate } from "@/lib/dates";
import { arrMismatches, type ArrMismatch } from "./waterfall";

/**
 * Nightly ARR cross-check (D9) for one chunk of accounts: revenue events against the contract in
 * force. A disagreement opens (or refreshes) one ARR_MISMATCH data-quality item per account and
 * currency; one that no longer disagrees is resolved; a dismissed one stays dismissed. Nothing is
 * corrected. The text carries no money figure (the data-quality screen is for Admins and CS
 * Leaders, who may not have revenue access); the ids point at the records.
 */
export interface ArrCheckCounts {
  mismatches: number;
  opened: number;
  resolved: number;
}

const keyOf = (accountId: string, currency: string) => `arr-mismatch:${accountId}:${currency}`;

export function mismatchDetail(m: ArrMismatch): string {
  return (
    `Revenue events and the contract in force disagree on this account's ARR in ${m.currency}. ` +
    `${m.contractId ? `Contract ${m.contractId}` : "No contract in force in this currency"}; ` +
    `${m.eventIds.length} revenue event${m.eventIds.length === 1 ? "" : "s"} on record. ` +
    `Nothing was changed; check the contract and its dates on the Billing tab.`
  );
}

export async function syncArrChecks(
  ctx: TenantContext,
  accountIds: readonly string[],
  asOf: CalendarDate,
): Promise<ArrCheckCounts> {
  const db = scopedDb(ctx);
  const [events, contracts, existing] = await Promise.all([
    db.revenueEvent.findMany({ where: { accountId: { in: [...accountIds] } } }),
    db.contract.findMany({ where: { accountId: { in: [...accountIds] } } }),
    db.dataQualityIssue.findMany({
      where: { kind: "ARR_MISMATCH", accountId: { in: [...accountIds] } },
    }),
  ]);
  const found = arrMismatches(
    events.map((e) => ({
      id: e.id,
      accountId: e.accountId,
      type: e.type,
      deltaArrMinor: e.deltaArrMinor,
      currency: e.currency,
      effectiveDate: calendarDateOf(e.effectiveDate),
    })),
    contracts.map((c) => ({
      id: c.id,
      accountId: c.accountId,
      startDate: c.startDate,
      endDate: c.endDate,
      valueMinor: c.valueMinor,
      currency: c.currency,
      status: c.status,
    })),
    asOf,
  );
  const byKey = new Map(existing.map((i) => [i.dedupeKey, i]));
  const seen = new Set<string>();
  let opened = 0;
  for (const m of found) {
    const key = keyOf(m.accountId, m.currency);
    seen.add(key);
    const detail = mismatchDetail(m);
    const prev = byKey.get(key);
    if (!prev) {
      await db.dataQualityIssue.create({
        data: {
          workspaceId: ctx.workspaceId,
          accountId: m.accountId,
          kind: "ARR_MISMATCH",
          detail,
          suggestedFix: { type: "NONE" },
          dedupeKey: key,
        },
      });
      opened++;
    } else if (prev.status !== "DISMISSED" && (prev.status !== "OPEN" || prev.detail !== detail)) {
      await db.dataQualityIssue.update({
        where: { id: prev.id },
        data: { detail, status: "OPEN" },
      });
      if (prev.status !== "OPEN") opened++;
    }
  }
  const gone = existing.filter((i) => i.status === "OPEN" && !seen.has(i.dedupeKey));
  if (gone.length)
    await db.dataQualityIssue.updateMany({
      where: { id: { in: gone.map((i) => i.id) } },
      data: { status: "RESOLVED" },
    });
  return { mismatches: found.length, opened, resolved: gone.length };
}
