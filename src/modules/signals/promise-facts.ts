import { calendarDateOf } from "@/lib/dates";
import type { ScopedDb } from "@/lib/db/scoped";
import type { PromiseFacts } from "./rules";

/**
 * M9: the promise rules' inputs for a chunk of accounts, in one set-based read. A promise's stored
 * evidence travels with it; its status is recomputed by the rule from dates (promises/status.ts),
 * never read from the stored column, so a date and a status can never disagree.
 */
export async function loadPromiseFacts(
  db: ScopedDb,
  accountIds: string[],
): Promise<Map<string, PromiseFacts[]>> {
  const out = new Map<string, PromiseFacts[]>();
  if (accountIds.length === 0) return out;
  const rows = await db.promise.findMany({
    where: { accountId: { in: accountIds } },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
  });
  for (const p of rows) {
    const list = out.get(p.accountId) ?? [];
    list.push({
      id: p.id,
      party: p.party,
      what: p.what,
      dueDate: p.dueDate ? calendarDateOf(p.dueDate) : null,
      ownerMembershipId: p.ownerMembershipId,
      evidence:
        p.evidenceType && p.evidenceId && p.keptAt
          ? { type: p.evidenceType, id: p.evidenceId, date: calendarDateOf(p.keptAt) }
          : null,
      sourceType: p.sourceType,
      sourceId: p.sourceId,
      quote: p.quote,
    });
    out.set(p.accountId, list);
  }
  return out;
}
