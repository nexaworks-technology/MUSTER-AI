import type { Extraction, InboxMatchedBy, InboxStatus, Prisma, RecordSource } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import { businessClock } from "@/lib/dates";
import { listActiveWorkspaces } from "@/lib/db/workspace";
import { requirePermission } from "@/lib/auth/permissions";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { bookWhere, type Actor } from "@/modules/accounts/service";
import { currentExtractions, labelOf, type DisplayLabel } from "@/modules/conversations/service";
import { detectSensitive } from "@/modules/outbound/service";
import { matchSender, senderAddress, senderDomain } from "./matching";

/**
 * The Inbox (M9, Rule 4: a view, not a second store). Inbound mail finds exactly one account or
 * waits in the Unmatched queue; matched mail becomes an ordinary Conversation + Message (the same
 * records every other source writes) plus a triage row; and `syncInbox` builds the same triage rows
 * from the emails and tickets that already exist. Nothing here sends anything: replies go through
 * Approvals and `outbound.dispatch` (B2).
 */
export type MailProvider = Extract<
  RecordSource,
  "GMAIL" | "MICROSOFT_EMAIL" | "ZENDESK" | "FRESHDESK"
>;

export interface InboundMail {
  provider: MailProvider;
  externalId: string;
  from: string;
  to: string[];
  subject: string;
  bodyText: string;
  receivedAt: Date;
  threadId?: string;
}

export type ReceiveResult =
  | { outcome: "MATCHED"; accountId: string; messageId: string; matchedBy: InboxMatchedBy }
  | { outcome: "UNMATCHED"; unmatchedId: string; reason: string }
  | { outcome: "BOUNCE"; contactId: string }
  | { outcome: "IGNORED"; reason: string }
  | { outcome: "DUPLICATE" };

const BOUNCE_SENDER = /^(mailer-daemon|postmaster)@/i;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export class InboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxError";
  }
}

async function alreadySeen(ctx: TenantContext, mail: InboundMail): Promise<boolean> {
  const db = scopedDb(ctx);
  const [ref, held] = await Promise.all([
    db.externalRef.findFirst({
      where: { source: mail.provider, objectType: "Message", externalId: mail.externalId },
      select: { id: true },
    }),
    db.unmatchedInbound.findFirst({
      where: { provider: mail.provider, externalId: mail.externalId },
      select: { id: true },
    }),
  ]);
  return Boolean(ref || held);
}

/** A delivery-failure notice: mark the contacts it names BOUNCED (the database stamps the date). */
async function applyBounce(ctx: TenantContext, mail: InboundMail): Promise<ReceiveResult> {
  const db = scopedDb(ctx);
  const named = [
    ...new Set((mail.bodyText.match(EMAIL_IN_TEXT) ?? []).map((e) => e.toLowerCase())),
  ];
  const contacts = named.length
    ? await db.contact.findMany({
        where: {
          OR: named.map((email) => ({ email: { equals: email, mode: "insensitive" as const } })),
        },
        select: { id: true },
      })
    : [];
  await db.externalRef.create({
    data: {
      workspaceId: ctx.workspaceId,
      source: mail.provider,
      objectType: "Message",
      externalId: mail.externalId,
      internalType: "Contact",
      internalId: contacts[0]?.id ?? "none",
    },
  });
  if (contacts.length === 0)
    return { outcome: "IGNORED", reason: "A bounce notice that names no known contact." };
  await db.contact.updateMany({
    where: { id: { in: contacts.map((c) => c.id) }, status: { not: "BOUNCED" } },
    data: { status: "BOUNCED" },
  });
  return { outcome: "BOUNCE", contactId: contacts[0]!.id };
}

export async function receiveInboundMail(
  ctx: TenantContext,
  mail: InboundMail,
): Promise<ReceiveResult> {
  const db = scopedDb(ctx);
  if (await alreadySeen(ctx, mail)) return { outcome: "DUPLICATE" };
  const address = senderAddress(mail.from);
  if (address && BOUNCE_SENDER.test(address)) return applyBounce(ctx, mail);

  const domain = senderDomain(mail.from);
  const [contacts, accounts] = await Promise.all([
    address
      ? db.contact.findMany({
          where: { email: { equals: address, mode: "insensitive" } },
          select: { id: true, email: true, accountId: true },
        })
      : [],
    domain
      ? db.account.findMany({
          where: { domain: { contains: domain, mode: "insensitive" } },
          select: { id: true, domain: true },
        })
      : [],
  ]);
  const match = matchSender({ from: mail.from, contacts, accounts });

  if (match.kind === "UNMATCHED") {
    const row = await db.unmatchedInbound.create({
      data: {
        workspaceId: ctx.workspaceId,
        provider: mail.provider,
        externalId: mail.externalId,
        fromAddress: address ?? mail.from,
        toAddresses: mail.to,
        subject: mail.subject,
        bodyText: mail.bodyText,
        receivedAt: mail.receivedAt,
        reason: match.reason,
        candidateAccountIds: match.candidateAccountIds,
      },
    });
    return { outcome: "UNMATCHED", unmatchedId: row.id, reason: match.reason };
  }

  const messageId = await db.$tenantTransaction(async (tx) => {
    const thread = mail.threadId
      ? await tx.conversation.findFirst({
          where: { accountId: match.accountId, externalThreadId: mail.threadId },
          select: { id: true, lastMessageAt: true },
        })
      : null;
    const conversationId =
      thread?.id ??
      (
        await tx.conversation.create({
          data: {
            workspaceId: ctx.workspaceId,
            accountId: match.accountId,
            channel: "EMAIL",
            subject: mail.subject,
            startedAt: mail.receivedAt,
            lastMessageAt: mail.receivedAt,
            externalThreadId: mail.threadId ?? null,
            source: mail.provider,
          },
        })
      ).id;
    if (thread && thread.lastMessageAt < mail.receivedAt)
      await tx.conversation.update({
        where: { id: thread.id },
        data: { lastMessageAt: mail.receivedAt },
      });
    const message = await tx.message.create({
      data: {
        workspaceId: ctx.workspaceId,
        accountId: match.accountId,
        conversationId,
        direction: "INBOUND",
        fromContactId: match.contactId,
        fromAddress: address,
        toAddresses: mail.to,
        sentAt: mail.receivedAt,
        subject: mail.subject,
        bodyText: mail.bodyText,
        source: mail.provider,
      },
    });
    await tx.externalRef.create({
      data: {
        workspaceId: ctx.workspaceId,
        source: mail.provider,
        objectType: "Message",
        externalId: mail.externalId,
        internalType: "Message",
        internalId: message.id,
      },
    });
    await tx.inboxItem.create({
      data: {
        workspaceId: ctx.workspaceId,
        accountId: match.accountId,
        sourceType: "MESSAGE",
        sourceId: message.id,
        matchedBy: match.matchedBy,
        receivedAt: mail.receivedAt,
      },
    });
    return message.id;
  });
  return { outcome: "MATCHED", accountId: match.accountId, messageId, matchedBy: match.matchedBy };
}

async function pendingRow(actor: Actor, id: string) {
  const row = await scopedDb(actor).unmatchedInbound.findUnique({ where: { id } });
  if (!row) throw new InboxError("That unmatched message was not found.");
  if (row.status !== "PENDING") throw new InboxError("That message was already decided.");
  return row;
}

/** A person puts an unmatched email on an account: it becomes a Conversation + Message, the holding text is cleared. */
export async function assignUnmatched(
  actor: Actor,
  input: { id: string; accountId: string },
): Promise<{ messageId: string }> {
  const grant = requirePermission(actor, "accounts:edit");
  const db = scopedDb(actor);
  const row = await pendingRow(actor, input.id);
  const account = await db.account.findUnique({
    where: { id: input.accountId },
    select: { id: true, ownerMembershipId: true },
  });
  if (!account) throw new InboxError("That account was not found in this workspace.");
  if (grant.scope === "OWN" && account.ownerMembershipId !== actor.membershipId)
    throw new InboxError("That account is not in your book.");
  const contact = await db.contact.findFirst({
    where: { accountId: account.id, email: { equals: row.fromAddress, mode: "insensitive" } },
    select: { id: true },
  });
  const messageId = await db.$tenantTransaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: account.id,
        channel: "EMAIL",
        subject: row.subject,
        startedAt: row.receivedAt,
        lastMessageAt: row.receivedAt,
        source: row.provider,
      },
    });
    const message = await tx.message.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: account.id,
        conversationId: conversation.id,
        direction: "INBOUND",
        fromContactId: contact?.id ?? null,
        fromAddress: row.fromAddress,
        toAddresses: row.toAddresses,
        sentAt: row.receivedAt,
        subject: row.subject,
        bodyText: row.bodyText ?? "",
        source: row.provider,
      },
    });
    await tx.externalRef.create({
      data: {
        workspaceId: actor.workspaceId,
        source: row.provider,
        objectType: "Message",
        externalId: row.externalId,
        internalType: "Message",
        internalId: message.id,
      },
    });
    await tx.inboxItem.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: account.id,
        sourceType: "MESSAGE",
        sourceId: message.id,
        matchedBy: "MANUAL",
        receivedAt: row.receivedAt,
      },
    });
    await tx.unmatchedInbound.update({
      where: { id: row.id },
      data: {
        status: "ASSIGNED",
        bodyText: null,
        assignedAccountId: account.id,
        assignedMessageId: message.id,
        decidedByMembershipId: actor.membershipId,
        decidedAt: new Date(),
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "inbox.unmatched_assigned",
        targetType: "UnmatchedInbound",
        targetId: row.id,
        summary: `Assigned an unmatched email from ${row.fromAddress} to an account`,
        before: { status: "PENDING", reason: row.reason },
        after: { status: "ASSIGNED", accountId: account.id, messageId: message.id },
      },
      tx,
    );
    return message.id;
  });
  return { messageId };
}

export async function dismissUnmatched(actor: Actor, input: { id: string }): Promise<void> {
  requirePermission(actor, "accounts:edit");
  const db = scopedDb(actor);
  const row = await pendingRow(actor, input.id);
  await db.$tenantTransaction(async (tx) => {
    await tx.unmatchedInbound.update({
      where: { id: row.id },
      data: {
        status: "DISMISSED",
        bodyText: null,
        decidedByMembershipId: actor.membershipId,
        decidedAt: new Date(),
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "inbox.unmatched_dismissed",
        targetType: "UnmatchedInbound",
        targetId: row.id,
        summary: `Dismissed an unmatched email from ${row.fromAddress}`,
        before: { status: "PENDING", reason: row.reason },
        after: { status: "DISMISSED" },
      },
      tx,
    );
  });
}

export const INBOX_LOOKBACK_DAYS = 30;

/**
 * Triage rows from the records that already exist, in a fixed number of reads: every inbound email
 * or chat message of the last 30 days, and every ticket opened in that time or still open. A
 * ticket's own messages are covered by the ticket's row. Status only moves forward from the
 * records: a later message from us is REPLIED, a closed ticket CLOSED. Idempotent.
 */
export async function syncInbox(
  ctx: TenantContext,
  opts: { now: Date; lookbackDays?: number },
): Promise<{ created: number; advanced: number }> {
  const db = scopedDb(ctx);
  const since = new Date(
    opts.now.getTime() - (opts.lookbackDays ?? INBOX_LOOKBACK_DAYS) * 86_400_000,
  );
  const [rawMessages, tickets, items] = await Promise.all([
    db.message.findMany({
      where: {
        direction: "INBOUND",
        sentAt: { gte: since },
        conversation: { channel: { in: ["EMAIL", "CHAT"] } },
      },
      select: { id: true, accountId: true, conversationId: true, sentAt: true, fromAddress: true },
    }),
    db.ticket.findMany({
      where: {
        conversationId: { not: null },
        OR: [{ openedAt: { gte: since } }, { status: { not: "CLOSED" } }],
      },
      select: { id: true, accountId: true, conversationId: true, openedAt: true, status: true },
    }),
    db.inboxItem.findMany({ select: { id: true, sourceType: true, sourceId: true, status: true } }),
  ]);
  // Delivery-failure notices are not conversations: the contact is marked BOUNCED instead.
  const messages = rawMessages.filter((m) => !BOUNCE_SENDER.test(m.fromAddress ?? ""));
  const conversationIds = [
    ...new Set([
      ...messages.map((m) => m.conversationId),
      ...tickets.map((t) => t.conversationId!),
    ]),
  ];
  const thread = await db.message.findMany({
    where: { conversationId: { in: conversationIds } },
    select: { conversationId: true, direction: true, sentAt: true },
  });
  const lastInbound = new Map<string, Date>();
  const lastOutbound = new Map<string, Date>();
  for (const m of thread) {
    const map = m.direction === "INBOUND" ? lastInbound : lastOutbound;
    const cur = map.get(m.conversationId);
    if (!cur || cur < m.sentAt) map.set(m.conversationId, m.sentAt);
  }
  const have = new Map(items.map((i) => [`${i.sourceType}:${i.sourceId}`, i]));
  const wanted = [
    ...messages.map((m) => ({
      sourceType: "MESSAGE" as const,
      sourceId: m.id,
      accountId: m.accountId,
      receivedAt: m.sentAt,
      conversationId: m.conversationId,
      closed: false,
    })),
    ...tickets.map((t) => ({
      sourceType: "TICKET" as const,
      sourceId: t.id,
      accountId: t.accountId,
      receivedAt: lastInbound.get(t.conversationId!) ?? t.openedAt,
      conversationId: t.conversationId!,
      closed: t.status === "CLOSED",
    })),
  ];
  const statusOf = (w: (typeof wanted)[number]) =>
    w.closed
      ? ("CLOSED" as const)
      : (lastOutbound.get(w.conversationId) ?? new Date(0)) > w.receivedAt
        ? ("REPLIED" as const)
        : ("NEW" as const);
  const fresh = wanted.filter((w) => !have.has(`${w.sourceType}:${w.sourceId}`));
  if (fresh.length)
    await db.inboxItem.createMany({
      data: fresh.map((w) => ({
        workspaceId: ctx.workspaceId,
        accountId: w.accountId,
        sourceType: w.sourceType,
        sourceId: w.sourceId,
        matchedBy: "SOURCE" as const,
        receivedAt: w.receivedAt,
        status: statusOf(w),
      })),
      skipDuplicates: true,
    });
  let advanced = 0;
  const RANK = { NEW: 0, DRAFTED: 1, REPLIED: 2, CLOSED: 3 } as const;
  for (const w of wanted) {
    const cur = have.get(`${w.sourceType}:${w.sourceId}`);
    if (!cur) continue;
    const next = statusOf(w);
    if (RANK[next] > RANK[cur.status]) {
      await db.inboxItem.update({ where: { id: cur.id }, data: { status: next } });
      advanced++;
    }
  }
  return { created: fresh.length, advanced };
}

/** Every active workspace's inbox, from its existing records (the 15-minute `inbox.sync` job). */
export async function syncAllInboxes(): Promise<
  Record<string, { created: number; advanced: number }>
> {
  const out: Record<string, { created: number; advanced: number }> = {};
  for (const w of await listActiveWorkspaces())
    out[w.slug] = await syncInbox({ workspaceId: w.id }, { now: businessClock() });
  return out;
}

// ─── Read model for /inbox (M9 B1) ─────────────────────────────────────────────────────────

export interface InboxRow {
  id: string;
  account: { id: string; name: string };
  sourceType: "MESSAGE" | "TICKET";
  sourceId: string;
  status: InboxStatus;
  matchedBy: InboxMatchedBy;
  receivedAt: Date;
  title: string;
  snippet: string;
  from: string;
  /** Read from Extraction at display; never stored on the row (Rule 4). */
  intent: string | null;
  sentiment: { label: string; quote: string } | null;
  labels: Array<DisplayLabel & { quote: string }>;
  sensitive: { isSensitive: boolean; reasons: string[] };
  theme: string | null;
  relatedTickets: Array<{ id: string; subject: string }>;
  hasDraft: boolean;
  draftOutboundMessageId: string | null;
}

export const INBOX_PAGE = 20;
const SNIPPET = 180;
const snip = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > SNIPPET ? `${t.slice(0, SNIPPET - 1)}…` : t;
};
const encodeCursor = (d: Date, id: string) => `${d.toISOString()}|${id}`;
function decodeCursor(c: string): { at: Date; id: string } | null {
  const [iso, id] = c.split("|");
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(+at) && id ? { at, id } : null;
}

/**
 * The inbox page: triage rows (newest first, cursor-paged) joined with what their source records
 * and verified extractions say, in a fixed number of reads whatever the page holds.
 */
export async function listInbox(
  actor: Actor,
  q: { cursor?: string; status?: "OPEN" | "ALL"; accountId?: string },
  take = INBOX_PAGE,
): Promise<{ items: InboxRow[]; nextCursor: string | null }> {
  const grant = requirePermission(actor, "accounts:view");
  const db = scopedDb(actor);
  const cur = q.cursor ? decodeCursor(q.cursor) : null;
  const where: Prisma.InboxItemWhereInput = {
    account: bookWhere(actor, grant.scope),
    ...(q.status === "ALL" ? {} : { status: { in: ["NEW", "DRAFTED"] } }),
    ...(q.accountId ? { accountId: q.accountId } : {}),
    ...(cur
      ? { OR: [{ receivedAt: { lt: cur.at } }, { receivedAt: cur.at, id: { lt: cur.id } }] }
      : {}),
  };
  const found = await db.inboxItem.findMany({
    where,
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: { account: { select: { id: true, name: true } } },
  });
  const page = found.slice(0, take);
  const nextCursor =
    found.length > take ? encodeCursor(page[take - 1]!.receivedAt, page[take - 1]!.id) : null;
  return { items: await buildRows(db, page), nextCursor };
}

type ItemWithAccount = Prisma.InboxItemGetPayload<{
  include: { account: { select: { id: true; name: true } } };
}>;

/** One inbox row, built the same way the list builds them (the Support Risk Agent reads this). */
export async function inboxRowFor(
  ctx: TenantContext,
  inboxItemId: string,
): Promise<InboxRow | null> {
  const db = scopedDb(ctx);
  const item = await db.inboxItem.findUnique({
    where: { id: inboxItemId },
    include: { account: { select: { id: true, name: true } } },
  });
  return item ? (await buildRows(db, [item]))[0]! : null;
}

async function buildRows(
  db: ReturnType<typeof scopedDb>,
  page: ItemWithAccount[],
): Promise<InboxRow[]> {
  if (page.length === 0) return [];
  const accountIds = [...new Set(page.map((i) => i.accountId))];
  const messageIds = page.filter((i) => i.sourceType === "MESSAGE").map((i) => i.sourceId);
  const [messages, tickets] = await Promise.all([
    db.message.findMany({
      where: { id: { in: messageIds } },
      select: {
        id: true,
        subject: true,
        bodyText: true,
        fromAddress: true,
        fromContact: { select: { name: true } },
      },
    }),
    // Every ticket of these accounts: the page's own, and the others a theme can link to.
    db.ticket.findMany({
      where: { accountId: { in: accountIds }, conversationId: { not: null } },
      select: { id: true, accountId: true, subject: true, conversationId: true, openedAt: true },
      orderBy: [{ openedAt: "desc" }, { id: "asc" }],
      take: 500,
    }),
  ]);
  const ticketMessages = await db.message.findMany({
    where: { conversationId: { in: tickets.map((t) => t.conversationId!) }, direction: "INBOUND" },
    select: {
      id: true,
      conversationId: true,
      bodyText: true,
      sentAt: true,
      fromContact: { select: { name: true } },
    },
    orderBy: [{ sentAt: "desc" }, { id: "asc" }],
  });
  const latestInbound = new Map<string, (typeof ticketMessages)[number]>();
  for (const m of ticketMessages)
    if (!latestInbound.has(m.conversationId)) latestInbound.set(m.conversationId, m);
  const readSources = [...messageIds, ...ticketMessages.map((m) => m.id)];
  const read = await currentExtractions(db, {
    accountIds,
    sourceType: "MESSAGE",
    sourceIds: readSources,
  });
  const bySource = new Map<string, Extraction[]>();
  for (const r of read) bySource.set(r.sourceId, [...(bySource.get(r.sourceId) ?? []), r]);
  const themeOf = (rows: Extraction[]) => {
    const t = rows.find((r) => r.kind === "COMPLAINT" || r.kind === "THEME")?.payload as
      { theme?: string } | undefined;
    return t?.theme && t.theme !== "other" ? t.theme : null;
  };
  // Ticket → its theme, from the extractions on any of its customer messages.
  const ticketTheme = new Map<string, string>();
  for (const t of tickets) {
    const msgIds = ticketMessages
      .filter((m) => m.conversationId === t.conversationId)
      .map((m) => m.id);
    const theme = themeOf(msgIds.flatMap((id) => bySource.get(id) ?? []));
    if (theme) ticketTheme.set(t.id, theme);
  }
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  const messageById = new Map(messages.map((m) => [m.id, m]));

  const items: InboxRow[] = page.map((i) => {
    let title = "";
    let body = "";
    let from = "Unknown sender";
    let sourceMessageIds: string[] = [];
    if (i.sourceType === "MESSAGE") {
      const m = messageById.get(i.sourceId);
      title = m?.subject ?? "(no subject)";
      body = m?.bodyText ?? "";
      from = m?.fromContact?.name ?? m?.fromAddress ?? from;
      sourceMessageIds = [i.sourceId];
    } else {
      const t = ticketById.get(i.sourceId);
      const last = t ? latestInbound.get(t.conversationId!) : undefined;
      title = t?.subject ?? "(ticket)";
      body = last?.bodyText ?? "";
      from = last?.fromContact?.name ?? "Ticket requester";
      sourceMessageIds = t
        ? ticketMessages.filter((m) => m.conversationId === t.conversationId).map((m) => m.id)
        : [];
    }
    const mine = sourceMessageIds.flatMap((id) => bySource.get(id) ?? []);
    const sentiment = mine.find((r) => r.kind === "SENTIMENT");
    const intent = mine.find((r) => r.kind === "INTENT");
    const theme = themeOf(mine);
    const sens = detectSensitive({
      texts: [title, body],
      extractions: mine.map((r) => ({ kind: r.kind, payload: r.payload })),
    });
    return {
      id: i.id,
      account: i.account,
      sourceType: i.sourceType,
      sourceId: i.sourceId,
      status: i.status,
      matchedBy: i.matchedBy,
      receivedAt: i.receivedAt,
      title,
      snippet: snip(body),
      from,
      intent: (intent?.payload as { intent?: string } | undefined)?.intent ?? null,
      sentiment: sentiment
        ? {
            label: String((sentiment.payload as { label?: string }).label ?? ""),
            quote: sentiment.quote,
          }
        : null,
      labels: mine
        .filter((r) => r.kind !== "SENTIMENT" && r.kind !== "INTENT")
        .map((r) => ({ ...labelOf(r.kind, r.payload as Record<string, unknown>), quote: r.quote })),
      sensitive: { isSensitive: sens.isSensitive, reasons: sens.reasons },
      theme,
      relatedTickets: theme
        ? tickets
            .filter(
              (t) =>
                t.accountId === i.accountId &&
                t.id !== i.sourceId &&
                ticketTheme.get(t.id) === theme,
            )
            .map((t) => ({ id: t.id, subject: t.subject }))
        : [],
      hasDraft: i.draftOutboundMessageId !== null,
      draftOutboundMessageId: i.draftOutboundMessageId,
    };
  });
  return items;
}

export interface UnmatchedRow {
  id: string;
  fromAddress: string;
  subject: string | null;
  snippet: string;
  receivedAt: Date;
  reason: string;
  candidates: Array<{ id: string; name: string }>;
}

/** Mail waiting for a person to place it (newest first). Needs `accounts:edit`, like assigning. */
export async function listUnmatched(actor: Actor): Promise<UnmatchedRow[]> {
  requirePermission(actor, "accounts:edit");
  const db = scopedDb(actor);
  const rows = await db.unmatchedInbound.findMany({
    where: { status: "PENDING" },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: 100,
  });
  const ids = [...new Set(rows.flatMap((r) => r.candidateAccountIds))];
  const accounts = await db.account.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  const name = new Map(accounts.map((a) => [a.id, a.name]));
  return rows.map((r) => ({
    id: r.id,
    fromAddress: r.fromAddress,
    subject: r.subject,
    snippet: snip(r.bodyText ?? ""),
    receivedAt: r.receivedAt,
    reason: r.reason,
    candidates: r.candidateAccountIds.flatMap((id) =>
      name.has(id) ? [{ id, name: name.get(id)! }] : [],
    ),
  }));
}

/** Accounts a person may put unmatched mail on (their book, not archived), by name. */
export async function listAssignableAccounts(
  actor: Actor,
): Promise<Array<{ id: string; name: string }>> {
  const grant = requirePermission(actor, "accounts:edit");
  return scopedDb(actor).account.findMany({
    where: { AND: [bookWhere(actor, grant.scope), { archivedAt: null }] },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 300,
  });
}
