import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import type { TimelineItem } from "@/modules/accounts/schemas";
import { AccountNotFoundError, getAccount, type Actor } from "@/modules/accounts/service";

/**
 * Conversations for Account 360: email/chat threads and calls (tickets have their own tab).
 * The message and transcript text here is what extraction will read in M4/M9.
 */
export const CONVERSATION_PAGE = 20;

const LISTED_CHANNELS = ["EMAIL", "CHAT", "CALL", "MEETING"] as const;

/**
 * Where one message sits on the Conversations tab: the page offset and its thread. A health
 * reason links to a single message, so the link must open the page that holds it. Null when the
 * message is not this account's (or this workspace's) or is not on this tab (tickets).
 */
export async function conversationPageFor(
  actor: Actor,
  accountId: string,
  messageId: string,
): Promise<{ offset: number; conversationId: string } | null> {
  const db = scopedDb(actor);
  const message = await db.message.findFirst({
    where: { id: messageId, accountId },
    select: { conversation: { select: { id: true, channel: true, lastMessageAt: true } } },
  });
  const c = message?.conversation;
  if (!c || !(LISTED_CHANNELS as readonly string[]).includes(c.channel)) return null;
  // Same order as listConversations: lastMessageAt desc, then id asc.
  const before = await db.conversation.count({
    where: {
      accountId,
      channel: { in: [...LISTED_CHANNELS] },
      OR: [
        { lastMessageAt: { gt: c.lastMessageAt } },
        { lastMessageAt: c.lastMessageAt, id: { lt: c.id } },
      ],
    },
  });
  return {
    offset: Math.floor(before / CONVERSATION_PAGE) * CONVERSATION_PAGE,
    conversationId: c.id,
  };
}

export async function listConversations(actor: Actor, accountId: string, cursor = 0) {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  const rows = await scopedDb(actor).conversation.findMany({
    where: { accountId, channel: { in: [...LISTED_CHANNELS] } },
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

/** Emails/chats (one item per message) and calls (one item per transcript). */
export async function conversationTimeline(
  db: ScopedDb,
  accountId: string,
  upTo: Date,
  take: number,
): Promise<TimelineItem[]> {
  const [messages, transcripts] = await Promise.all([
    db.message.findMany({
      where: {
        accountId,
        sentAt: { lte: upTo },
        conversation: { channel: { in: ["EMAIL", "CHAT"] } },
      },
      orderBy: { sentAt: "desc" },
      take,
      select: {
        id: true,
        direction: true,
        sentAt: true,
        subject: true,
        fromAddress: true,
        fromContact: { select: { name: true } },
        fromMember: { select: { user: { select: { name: true } } } },
      },
    }),
    db.callTranscript.findMany({
      where: { accountId, occurredAt: { lte: upTo } },
      orderBy: { occurredAt: "desc" },
      take,
      select: { id: true, title: true, occurredAt: true },
    }),
  ]);
  return [
    ...messages.map((m): TimelineItem => ({
      key: `message:${m.id}`,
      at: m.sentAt,
      kind: "email",
      title:
        m.direction === "INBOUND"
          ? `Email from ${m.fromContact?.name ?? m.fromAddress ?? "the customer"}: ${m.subject ?? "(no subject)"}`
          : `Email sent by ${m.fromMember?.user.name ?? m.fromAddress ?? "the team"}: ${m.subject ?? "(no subject)"}`,
      href: `/accounts/${accountId}/conversations`,
      sourceType: "Message",
      sourceId: m.id,
    })),
    ...transcripts.map((t): TimelineItem => ({
      key: `call:${t.id}`,
      at: t.occurredAt,
      kind: "call",
      title: `Call: ${t.title}`,
      href: `/accounts/${accountId}/conversations`,
      sourceType: "CallTranscript",
      sourceId: t.id,
    })),
  ];
}
