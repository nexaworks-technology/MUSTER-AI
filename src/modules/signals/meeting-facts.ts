import { calendarDateOf, type CalendarDate } from "@/lib/dates";
import type { ScopedDb } from "@/lib/db/scoped";

/**
 * M10: Meeting facts for signal evaluation (specifically `no_meeting_in_x_days`).
 * If no meetings exist at all in the workspace, returns null (rule remains dormant: never fires).
 * If meetings exist, returns map of accountId -> Array<{ id: string; date: CalendarDate }>.
 */
export async function loadMeetingFacts(
  db: ScopedDb,
  accountIds: string[],
): Promise<Map<string, Array<{ id: string; date: CalendarDate }>> | null> {
  if (accountIds.length === 0) return null;

  const anyMeeting = await db.meeting.findFirst({
    select: { id: true },
  });
  if (!anyMeeting) {
    return null;
  }

  const rows = await db.meeting.findMany({
    where: {
      accountId: { in: accountIds },
      status: { not: "CANCELLED" },
    },
    select: {
      id: true,
      accountId: true,
      startsAt: true,
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });

  const out = new Map<string, Array<{ id: string; date: CalendarDate }>>();
  for (const id of accountIds) {
    out.set(id, []);
  }
  for (const m of rows) {
    if (!m.accountId) continue;
    const list = out.get(m.accountId);
    if (list) {
      list.push({
        id: m.id,
        date: calendarDateOf(m.startsAt),
      });
    }
  }
  return out;
}
