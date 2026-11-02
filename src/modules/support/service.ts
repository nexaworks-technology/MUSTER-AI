import { scopedDb } from "@/lib/db/scoped";
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
