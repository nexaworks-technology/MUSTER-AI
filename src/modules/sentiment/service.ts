import { businessClock, daysBetween, todayIn, type CalendarDate } from "@/lib/dates";
import { requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { bookWhere, type Actor } from "@/modules/accounts/service";
import { loadTextFacts, type TextFact } from "@/modules/signals/service";

/**
 * Sentiment & themes (spec §6E1, M9 B5). Counts are computed here, by code, from verified
 * extractions (the latest prompt version per source, each label with its quote checked word for
 * word); the screen stores nothing. Only ticket-thread tone feeds the health score (the M4 path,
 * D-144); email and call tone are shown here and never scored. Every theme carries its quotes and a
 * link to each source record (Rule 1).
 */
export interface ThemeQuote {
  quote: string;
  date: CalendarDate;
  kind: string;
  sourceType: string;
  account: { id: string; name: string };
  href: string;
}

export interface ThemeRow {
  theme: string;
  label: string;
  count: number;
  accounts: number;
  quotes: ThemeQuote[];
}

export interface SentimentView {
  asOf: CalendarDate;
  days: number;
  mix: {
    total: number;
    byLabel: Record<"NEGATIVE" | "MIXED" | "NEUTRAL" | "POSITIVE", number>;
    bySource: Record<"ticket" | "email" | "call", { count: number; scored: boolean }>;
  };
  themes: ThemeRow[];
}

export const DEFAULT_SENTIMENT_DAYS = 90;
const SAMPLE = 3;

export async function getSentiment(
  actor: Actor,
  q: { asOf?: CalendarDate; days?: number; accountId?: string; theme?: string },
): Promise<SentimentView> {
  const grant = requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);
  const ws = await getOwnWorkspace(actor);
  const asOf = q.asOf ?? todayIn(ws.timezone, businessClock);
  const days = q.days ?? DEFAULT_SENTIMENT_DAYS;
  const accounts = await db.account.findMany({
    where: {
      AND: [
        bookWhere(actor, grant.scope),
        { archivedAt: null },
        ...(q.accountId ? [{ id: q.accountId }] : []),
      ],
    },
    select: { id: true, name: true },
  });
  const empty: SentimentView = {
    asOf,
    days,
    mix: {
      total: 0,
      byLabel: { NEGATIVE: 0, MIXED: 0, NEUTRAL: 0, POSITIVE: 0 },
      bySource: {
        ticket: { count: 0, scored: true },
        email: { count: 0, scored: false },
        call: { count: 0, scored: false },
      },
    },
    themes: [],
  };
  if (accounts.length === 0) return empty;
  const name = new Map(accounts.map((a) => [a.id, a.name]));
  const byAccount = await loadTextFacts(
    db,
    asOf,
    accounts.map((a) => a.id),
    ws.timezone,
  );
  const inWindow = (f: TextFact) =>
    f.direction !== "OUTBOUND" && daysBetween(f.date, asOf) < days && f.date <= asOf;
  const facts = [...byAccount].flatMap(([accountId, list]) =>
    list.filter(inWindow).map((f) => ({ ...f, accountId })),
  );
  const conversationIds = [
    ...new Set(
      facts.filter((f) => f.channel === "TICKET" && f.conversationId).map((f) => f.conversationId!),
    ),
  ];
  const tickets = await db.ticket.findMany({
    where: { conversationId: { in: conversationIds } },
    select: { id: true, conversationId: true },
    orderBy: { id: "asc" },
  });
  const ticketOf = new Map<string, string>();
  for (const t of tickets)
    if (t.conversationId && !ticketOf.has(t.conversationId)) ticketOf.set(t.conversationId, t.id);

  const hrefOf = (f: (typeof facts)[number]): string => {
    const base = `/accounts/${f.accountId}`;
    if (f.sourceType === "MESSAGE")
      return f.channel === "TICKET"
        ? `${base}/tickets${f.conversationId && ticketOf.has(f.conversationId) ? `#ticket-${ticketOf.get(f.conversationId)}` : ""}`
        : `${base}/conversations?message=${f.sourceId}#message-${f.sourceId}`;
    if (f.sourceType === "CALL_TRANSCRIPT") return `${base}/conversations`;
    if (f.sourceType === "NOTE") return `${base}/notes`;
    return base;
  };

  const mix = empty.mix;
  for (const f of facts) {
    if (f.kind !== "SENTIMENT" || !f.label) continue;
    mix.total++;
    mix.byLabel[f.label]++;
    const source =
      f.sourceType === "CALL_TRANSCRIPT" ? "call" : f.channel === "TICKET" ? "ticket" : "email";
    mix.bySource[source].count++;
  }

  const groups = new Map<string, Array<(typeof facts)[number]>>();
  for (const f of facts) {
    if ((f.kind !== "COMPLAINT" && f.kind !== "THEME") || !f.theme) continue;
    if (q.theme && f.theme !== q.theme) continue;
    groups.set(f.theme, [...(groups.get(f.theme) ?? []), f]);
  }
  const newest = (a: (typeof facts)[number], b: (typeof facts)[number]) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1;
  const themes: ThemeRow[] = [...groups]
    .map(([theme, list]) => {
      const sorted = [...list].sort(newest);
      return {
        theme,
        label: theme.replaceAll("_", " "),
        count: list.length,
        accounts: new Set(list.map((f) => f.accountId)).size,
        quotes: (q.theme ? sorted : sorted.slice(0, SAMPLE)).map((f) => ({
          quote: f.quote,
          date: f.date,
          kind: f.kind,
          sourceType: f.sourceType,
          account: { id: f.accountId, name: name.get(f.accountId) ?? "Account" },
          href: hrefOf(f),
        })),
      };
    })
    .sort((a, b) => b.count - a.count || a.theme.localeCompare(b.theme));
  return { asOf, days, mix, themes };
}
