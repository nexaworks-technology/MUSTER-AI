import { localDate, type CalendarDate } from "@/lib/dates";
import type { ScopedDb } from "@/lib/db/scoped";
import { currentExtractions, groupableTheme } from "@/modules/conversations/service";
import { workspaceSettingsData } from "@/modules/settings/schemas";
import type { TextFact, TextKind } from "./rules/text";

const KINDS: TextKind[] = [
  "SENTIMENT",
  "COMPETITOR",
  "BUDGET_CONCERN",
  "GOAL",
  "CANCEL_LANGUAGE",
  "EXPORT_LANGUAGE",
  "COMPLAINT",
  "RENEWAL_CONCERN",
  "THEME",
  "INTENT",
];

/**
 * M9: the text rules' inputs for a chunk of accounts, as of a date, in a fixed number of reads: the
 * current extractions (latest prompt version per source), the days of the messages, calls and notes
 * they were read from, and the workspace's theme list. Only extractions that carry a verified quote
 * exist (D-75), and every fact is dated by its source and cut at the as-of day.
 */
export async function loadTextFacts(
  db: ScopedDb,
  asOf: CalendarDate,
  accountIds: string[],
  timeZone: string,
): Promise<Map<string, TextFact[]>> {
  const out = new Map<string, TextFact[]>();
  if (accountIds.length === 0) return out;
  const [rows, settings] = await Promise.all([
    currentExtractions(db, { kinds: KINDS, accountIds }),
    db.workspaceSettings.findFirst({ select: { data: true } }),
  ]);
  const themes = workspaceSettingsData.parse(settings?.data ?? {}).extraction.themes;
  const ids = (t: string) => [
    ...new Set(rows.filter((r) => r.sourceType === t).map((r) => r.sourceId)),
  ];
  const [messages, calls, notes] = await Promise.all([
    db.message.findMany({
      where: { id: { in: ids("MESSAGE") } },
      select: {
        id: true,
        sentAt: true,
        direction: true,
        conversationId: true,
        conversation: { select: { channel: true } },
      },
    }),
    db.callTranscript.findMany({
      where: { id: { in: ids("CALL_TRANSCRIPT") } },
      select: { id: true, occurredAt: true },
    }),
    db.note.findMany({ where: { id: { in: ids("NOTE") } }, select: { id: true, createdAt: true } }),
  ]);
  const message = new Map(messages.map((m) => [m.id, m]));
  const call = new Map(calls.map((c) => [c.id, c.occurredAt]));
  const note = new Map(notes.map((n) => [n.id, n.createdAt]));

  for (const r of rows) {
    const m = r.sourceType === "MESSAGE" ? message.get(r.sourceId) : undefined;
    const when =
      r.sourceType === "MESSAGE"
        ? m?.sentAt
        : r.sourceType === "CALL_TRANSCRIPT"
          ? call.get(r.sourceId)
          : r.sourceType === "NOTE"
            ? note.get(r.sourceId)
            : undefined;
    if (!when) continue;
    const date = localDate(when, timeZone);
    if (date > asOf) continue;
    const payload = r.payload as Record<string, unknown>;
    const str = (k: string) => (typeof payload[k] === "string" ? (payload[k] as string) : null);
    const list = out.get(r.accountId) ?? [];
    list.push({
      id: r.id,
      kind: r.kind as TextKind,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      date,
      quote: r.quote,
      channel: m?.conversation.channel ?? null,
      conversationId: m?.conversationId ?? null,
      direction: m?.direction ?? null,
      theme: str("theme") ? groupableTheme(str("theme")!, themes) : null,
      competitor: str("competitorName"),
      intent: str("intent"),
      label: (str("label") as TextFact["label"]) ?? null,
    });
    out.set(r.accountId, list);
  }
  return out;
}
