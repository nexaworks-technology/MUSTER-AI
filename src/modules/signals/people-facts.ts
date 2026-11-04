import { localDate, type CalendarDate } from "@/lib/dates";
import type { ScopedDb } from "@/lib/db/scoped";
import type { TitleChange } from "./rules/people";

/**
 * M9: title changes for a chunk of accounts, in one read. The database stamps `titleChangedAt` and
 * keeps `previousTitle` on any real change (migration m9), so every writer is covered; changes
 * dated after the as-of day are not seen.
 */
export async function loadPeopleFacts(
  db: ScopedDb,
  asOf: CalendarDate,
  accountIds: string[],
  timeZone: string,
): Promise<Map<string, { titleChanges: TitleChange[] }>> {
  const out = new Map<string, { titleChanges: TitleChange[] }>();
  if (accountIds.length === 0) return out;
  const rows = await db.contact.findMany({
    where: { accountId: { in: accountIds }, titleChangedAt: { not: null } },
    select: {
      id: true,
      accountId: true,
      name: true,
      title: true,
      previousTitle: true,
      titleChangedAt: true,
    },
    orderBy: [{ titleChangedAt: "asc" }, { id: "asc" }],
  });
  for (const c of rows) {
    if (!c.title || !c.previousTitle || !c.titleChangedAt) continue;
    const changedOn = localDate(c.titleChangedAt, timeZone);
    if (changedOn > asOf) continue;
    const entry = out.get(c.accountId) ?? { titleChanges: [] };
    entry.titleChanges.push({
      contactId: c.id,
      name: c.name,
      previousTitle: c.previousTitle,
      title: c.title,
      changedOn,
    });
    out.set(c.accountId, entry);
  }
  return out;
}
