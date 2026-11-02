import { scopedDb } from "@/lib/db/scoped";
import { AccountNotFoundError, getAccount, type Actor } from "@/modules/accounts/service";

/**
 * Conversations for Account 360: email/chat threads and calls (tickets have their own tab).
 * The message and transcript text here is what extraction will read in M4/M9.
 */
export const CONVERSATION_PAGE = 20;

export async function listConversations(actor: Actor, accountId: string, cursor = 0) {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  const rows = await scopedDb(actor).conversation.findMany({
    where: { accountId, channel: { in: ["EMAIL", "CHAT", "CALL", "MEETING"] } },
    orderBy: [{ lastMessageAt: "desc" }, { id: "asc" }],
    skip: cursor,
    take: CONVERSATION_PAGE + 1,
    include: {
      messages: {
        orderBy: { sentAt: "asc" },
        select: {
          id: true,
          direction: true,
          sentAt: true,
          subject: true,
          bodyText: true,
          fromAddress: true,
          fromContact: { select: { name: true } },
          fromMember: { select: { user: { select: { name: true } } } },
        },
      },
      transcripts: {
        select: { id: true, title: true, occurredAt: true, text: true, durationSec: true },
      },
    },
  });
  return {
    conversations: rows.slice(0, CONVERSATION_PAGE).map((c) => ({
      id: c.id,
      channel: c.channel,
      subject: c.subject,
      lastMessageAt: c.lastMessageAt,
      transcripts: c.transcripts,
      messages: c.messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        sentAt: m.sentAt,
        subject: m.subject,
        bodyText: m.bodyText,
        from: m.fromContact?.name ?? m.fromMember?.user.name ?? m.fromAddress ?? "Unknown sender",
      })),
    })),
    nextCursor: rows.length > CONVERSATION_PAGE ? cursor + CONVERSATION_PAGE : null,
  };
}
