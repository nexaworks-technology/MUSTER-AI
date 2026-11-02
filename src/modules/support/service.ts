import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import type { TimelineItem } from "@/modules/accounts/schemas";
import { AccountNotFoundError, getAccount, type Actor } from "@/modules/accounts/service";

/** Tickets for Account 360 (read model). Open tickets first, then newest. */
export async function listTickets(actor: Actor, accountId: string, asOf = new Date()) {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  const tickets = await scopedDb(actor).ticket.findMany({
    where: { accountId },
    orderBy: [{ openedAt: "desc" }, { id: "asc" }],
    take: 100,
    include: {
      contact: { select: { name: true } },
      conversation: {
        select: {
          messages: {
            orderBy: { sentAt: "asc" },
            select: { id: true, direction: true, sentAt: true, bodyText: true, fromAddress: true },
          },
        },
      },
    },
  });
  const open = (t: (typeof tickets)[number]) => t.status === "OPEN" || t.status === "PENDING";
  return tickets
    .map((t) => ({
      id: t.id,
      externalId: t.externalId,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      isEscalated: t.isEscalated,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      contactName: t.contact?.name ?? null,
      /** Whole days the ticket has been open (still open) or was open (closed). */
      ageDays: Math.floor(((t.closedAt ?? asOf).getTime() - t.openedAt.getTime()) / 86_400_000),
      messages: t.conversation?.messages ?? [],
      isOpen: open(t),
    }))
    .sort((a, b) => Number(b.isOpen) - Number(a.isOpen));
}

/** Tickets opened and closed. */
export async function ticketTimeline(
  db: ScopedDb,
  accountId: string,
  upTo: Date,
  take: number,
): Promise<TimelineItem[]> {
  const tickets = await db.ticket.findMany({
    where: { accountId, openedAt: { lte: upTo } },
    orderBy: { openedAt: "desc" },
    take,
  });
  return tickets
    .flatMap((t): TimelineItem[] => [
      {
        key: `ticket:${t.id}:opened`,
        at: t.openedAt,
        kind: "ticket",
        title: `Ticket opened: ${t.subject}${t.priority === "HIGH" || t.priority === "URGENT" ? ` (${t.priority.toLowerCase()} priority)` : ""}${t.isEscalated ? ", escalated" : ""}`,
        href: `/accounts/${accountId}/tickets`,
        sourceType: "Ticket",
        sourceId: t.id,
      },
      ...(t.closedAt
        ? [
            {
              key: `ticket:${t.id}:closed`,
              at: t.closedAt,
              kind: "ticket" as const,
              title: `Ticket closed: ${t.subject}`,
              href: `/accounts/${accountId}/tickets`,
              sourceType: "Ticket",
              sourceId: t.id,
            },
          ]
        : []),
    ])
    .filter((i) => i.at <= upTo);
}
