import type { Prisma, RecordSource } from "@prisma/client";
import type { IngestCounts, IngestProblem } from "./ingest.service";
import type { NormalizedMail, NormalizedTicket } from "./normalized";

type Tx = Prisma.TransactionClient;

export interface IngestRunContext {
  target: { workspaceId: string; integrationId: string; source: RecordSource };
  tx: Tx;
  counts: IngestCounts;
  accountIds: Set<string>;
  problem(p: IngestProblem): void;
  refs(objectType: string, externalIds: string[]): Promise<Map<string, string>>;
  addRefs(objectType: string, internalType: string, pairs: Array<[string, string]>): Promise<void>;
}

const FREEMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
]);

function extractDomain(emailStr?: string | null): string | null {
  if (!emailStr) return null;
  const at = emailStr.lastIndexOf("@");
  if (at === -1) return null;
  const d = emailStr.slice(at + 1).toLowerCase().trim();
  return FREEMAIL.has(d) ? null : d;
}

/**
 * When support first answered: the earliest reply on the ticket that is not the requester's
 * (adapters mark those OUTBOUND; a reply from the requester's own address never counts). None yet
 * is null, never a guess (DEMO-WALKTHROUGH FAIL 43: answered tickets read as unanswered).
 */
export function firstResponseAt(t: NormalizedTicket): Date | null {
  const requester = t.requesterEmail?.toLowerCase() ?? null;
  const replies = t.messages
    .filter(
      (m) =>
        m.direction === "OUTBOUND" &&
        m.sentAt.getTime() >= t.openedAt.getTime() &&
        (!requester || m.fromAddress?.toLowerCase() !== requester),
    )
    .map((m) => m.sentAt.getTime());
  return replies.length ? new Date(Math.min(...replies)) : null;
}

/**
 * Ingests support tickets (Zendesk, Freshdesk) on the existing M5 framework.
 * Maps to Ticket + Conversation + Message + InboxItem through ExternalRef.
 * Unmatched tickets route to UnmatchedInbound.
 */
export async function ingestTickets(
  run: IngestRunContext,
  tickets: NormalizedTicket[],
): Promise<void> {
  const { tx, target } = run;
  const ticketRefs = await run.refs("Ticket", tickets.map((t) => t.externalId));

  for (const t of tickets) {
    const existingTicketId = ticketRefs.get(t.externalId);
    if (existingTicketId) {
      // Ticket already known: check if status/priority/closedAt changed
      const current = await tx.ticket.findUnique({
        where: { id: existingTicketId },
        select: {
          status: true,
          priority: true,
          closedAt: true,
          conversationId: true,
          firstResponseAt: true,
        },
      });
      // Recorded once: a ticket ingested before its first reply (or before this was recorded at
      // all) gets it on the next sync; a set value is never moved.
      const responded = current?.firstResponseAt ?? firstResponseAt(t);
      let updated = false;
      if (
        current &&
        (current.status !== t.status ||
          current.priority !== t.priority ||
          current.closedAt?.toISOString() !== t.closedAt?.toISOString() ||
          current.firstResponseAt?.getTime() !== responded?.getTime())
      ) {
        await tx.ticket.update({
          where: { id: existingTicketId },
          data: {
            status: t.status,
            priority: t.priority,
            closedAt: t.closedAt,
            firstResponseAt: responded,
          },
        });
        updated = true;
      }

      // Check any new messages on this ticket
      if (t.messages.length > 0 && current?.conversationId) {
        const msgRefs = await run.refs("Message", t.messages.map((m) => m.externalId));
        const newMsgs = t.messages.filter((m) => !msgRefs.has(m.externalId));
        for (const m of newMsgs) {
          const createdMsg = await tx.message.create({
            data: {
              workspaceId: target.workspaceId,
              conversationId: current.conversationId,
              accountId: (await tx.ticket.findUniqueOrThrow({ where: { id: existingTicketId } })).accountId,
              direction: m.direction,
              fromAddress: m.fromAddress ?? t.requesterEmail,
              toAddresses: m.toAddresses,
              sentAt: m.sentAt,
              subject: t.subject,
              bodyText: m.bodyText,
              source: target.source,
            },
          });
          await run.addRefs("Message", "Message", [[m.externalId, createdMsg.id]]);
          updated = true;
        }
      }

      if (updated) {
        run.counts.updated++;
      } else {
        run.counts.unchanged++;
      }
      continue;
    }

    // New ticket: resolve account matching
    let accountId: string | null = null;
    let contactId: string | null = null;

    if (t.requesterEmail) {
      const contacts = await tx.contact.findMany({
        where: {
          workspaceId: target.workspaceId,
          email: { equals: t.requesterEmail, mode: "insensitive" },
        },
        select: { id: true, accountId: true },
      });
      if (contacts.length === 1) {
        accountId = contacts[0]!.accountId;
        contactId = contacts[0]!.id;
      } else if (contacts.length === 0) {
        const domain = extractDomain(t.requesterEmail);
        if (domain) {
          const accounts = await tx.account.findMany({
            where: {
              workspaceId: target.workspaceId,
              domain: { contains: domain, mode: "insensitive" },
            },
            select: { id: true },
          });
          if (accounts.length === 1) {
            accountId = accounts[0]!.id;
          }
        }
      }
    }

    if (!accountId) {
      // Unmatched ticket routes to UnmatchedInbound (holding row)
      const existingUnmatched = await tx.unmatchedInbound.findUnique({
        where: {
          workspaceId_provider_externalId: {
            workspaceId: target.workspaceId,
            provider: target.source,
            externalId: t.externalId,
          },
        },
      });
      if (!existingUnmatched) {
        await tx.unmatchedInbound.create({
          data: {
            workspaceId: target.workspaceId,
            provider: target.source,
            externalId: t.externalId,
            fromAddress: t.requesterEmail ?? "unknown@unknown.test",
            toAddresses: [],
            subject: t.subject,
            bodyText: t.messages[0]?.bodyText ?? t.subject,
            receivedAt: t.openedAt,
            reason: t.requesterEmail
              ? `Ticket requester ${t.requesterEmail} could not be matched to an account`
              : (t.requesterUnresolvedReason ??
                "The ticket has no requester email, so it could not be matched to an account"),
            candidateAccountIds: [],
          },
        });
      }
      run.problem({
        kind: "UNMATCHED",
        objectType: "Ticket",
        externalId: t.externalId,
        reason: `Ticket ${t.externalId} could not be matched to an account`,
      });
      continue;
    }

    // Matched ticket: create Conversation + Ticket + Messages + InboxItem
    const lastMsgDate = t.messages.at(-1)?.sentAt ?? t.openedAt;
    const conversation = await tx.conversation.create({
      data: {
        workspaceId: target.workspaceId,
        accountId,
        channel: "TICKET",
        subject: t.subject,
        startedAt: t.openedAt,
        lastMessageAt: lastMsgDate,
        externalThreadId: t.externalId,
        source: target.source,
      },
    });

    const ticket = await tx.ticket.create({
      data: {
        workspaceId: target.workspaceId,
        accountId,
        contactId,
        conversationId: conversation.id,
        externalId: t.externalId,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        openedAt: t.openedAt,
        firstResponseAt: firstResponseAt(t),
        closedAt: t.closedAt,
        source: target.source,
      },
    });

    await run.addRefs("Ticket", "Ticket", [[t.externalId, ticket.id]]);
    await run.addRefs("Conversation", "Conversation", [[t.externalId, conversation.id]]);

    // Triage InboxItem
    await tx.inboxItem.create({
      data: {
        workspaceId: target.workspaceId,
        accountId,
        sourceType: "TICKET",
        sourceId: ticket.id,
        matchedBy: contactId ? "CONTACT_EMAIL" : "DOMAIN",
        receivedAt: t.openedAt,
      },
    });

    // Create messages on the thread
    for (const m of t.messages) {
      const msg = await tx.message.create({
        data: {
          workspaceId: target.workspaceId,
          conversationId: conversation.id,
          accountId,
          direction: m.direction,
          fromContactId: m.direction === "INBOUND" ? contactId : null,
          fromAddress: m.fromAddress ?? t.requesterEmail,
          toAddresses: m.toAddresses,
          sentAt: m.sentAt,
          subject: t.subject,
          bodyText: m.bodyText,
          source: target.source,
        },
      });
      await run.addRefs("Message", "Message", [[m.externalId, msg.id]]);
    }

    run.counts.created++;
    run.accountIds.add(accountId);
  }
}

/**
 * Ingests mailbox mail (Gmail, Microsoft Graph) on the existing M5 framework.
 * HARD PRIVACY RULE: ONLY mail matching a known contact email or account domain is kept;
 * everything else is discarded without being stored.
 */
export async function ingestMail(
  run: IngestRunContext,
  mailList: NormalizedMail[],
): Promise<void> {
  const { tx, target } = run;
  const messageRefs = await run.refs("Message", mailList.map((m) => m.externalId));

  for (const m of mailList) {
    if (messageRefs.has(m.externalId)) {
      run.counts.unchanged++;
      continue;
    }

    // Privacy rule matching: only keep mail matching a known contact email or account domain
    const emailsToCheck = [m.fromAddress, ...m.toAddresses];
    const contacts = await tx.contact.findMany({
      where: {
        workspaceId: target.workspaceId,
        email: { in: emailsToCheck, mode: "insensitive" },
      },
      select: { id: true, email: true, accountId: true },
    });

    let accountId: string | null = null;
    let contactId: string | null = null;
    let matchedBy: "CONTACT_EMAIL" | "DOMAIN" = "CONTACT_EMAIL";

    if (contacts.length >= 1) {
      // Exact contact email match
      accountId = contacts[0]!.accountId;
      contactId = contacts[0]!.id;
      matchedBy = "CONTACT_EMAIL";
    } else {
      // Check account domain match from sender
      const domain = extractDomain(m.fromAddress);
      if (domain) {
        const accounts = await tx.account.findMany({
          where: {
            workspaceId: target.workspaceId,
            domain: { contains: domain, mode: "insensitive" },
          },
          select: { id: true },
        });
        if (accounts.length === 1) {
          accountId = accounts[0]!.id;
          matchedBy = "DOMAIN";
        }
      }
    }

    if (!accountId) {
      // PRIVACY RULE: Discard without being stored!
      run.problem({
        kind: "SKIPPED",
        objectType: "Message",
        externalId: m.externalId,
        reason: "Mail sender or recipient does not match any known contact or account; discarded per privacy rule.",
      });
      continue;
    }

    // Matched mail: find or create Conversation
    let convId: string | null = null;
    if (m.threadExternalId) {
      const convRefs = await run.refs("Conversation", [m.threadExternalId]);
      convId = convRefs.get(m.threadExternalId) ?? null;
      if (convId) {
        await tx.conversation.update({
          where: { id: convId },
          data: { lastMessageAt: m.sentAt },
        });
      }
    }

    if (!convId) {
      const conv = await tx.conversation.create({
        data: {
          workspaceId: target.workspaceId,
          accountId,
          channel: "EMAIL",
          subject: m.subject || "No subject",
          startedAt: m.sentAt,
          lastMessageAt: m.sentAt,
          externalThreadId: m.threadExternalId,
          source: target.source,
        },
      });
      convId = conv.id;
      if (m.threadExternalId) {
        await run.addRefs("Conversation", "Conversation", [[m.threadExternalId, conv.id]]);
      }
    }

    const message = await tx.message.create({
      data: {
        workspaceId: target.workspaceId,
        conversationId: convId,
        accountId,
        direction: m.direction,
        fromContactId: m.direction === "INBOUND" ? contactId : null,
        fromAddress: m.fromAddress,
        toAddresses: m.toAddresses,
        sentAt: m.sentAt,
        subject: m.subject,
        bodyText: m.bodyText,
        source: target.source,
      },
    });

    await run.addRefs("Message", "Message", [[m.externalId, message.id]]);

    if (m.direction === "INBOUND") {
      await tx.inboxItem.create({
        data: {
          workspaceId: target.workspaceId,
          accountId,
          sourceType: "MESSAGE",
          sourceId: message.id,
          matchedBy,
          receivedAt: m.sentAt,
        },
      });
    }

    run.counts.created++;
    run.accountIds.add(accountId);
  }
}
