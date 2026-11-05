import { Prisma, type RecordSource } from "@prisma/client";
import type { IngestCounts, IngestProblem } from "./ingest.service";
import type { NormalizedMeeting, NormalizedTranscript } from "./normalized";

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
 * Matches an account from attendee emails (spec §6B):
 * 1. If any attendee email matches a known Contact, take that contact's account.
 * 2. If no contact matches, match on non-freemail email domain if it matches exactly one account.
 * 3. Otherwise returns null (unmatched meetings are never attached to an account).
 */
async function matchAccountFromEmails(
  tx: Tx,
  workspaceId: string,
  emails: string[],
): Promise<string | null> {
  const normalized = [...new Set(emails.map((e) => e.toLowerCase().trim()))];
  if (normalized.length === 0) return null;

  const contacts = await tx.contact.findMany({
    where: {
      workspaceId,
      email: { in: normalized, mode: "insensitive" },
    },
    select: { accountId: true },
  });

  const matchedAccountIds = [...new Set(contacts.map((c) => c.accountId))];
  if (matchedAccountIds.length === 1) {
    return matchedAccountIds[0]!;
  }
  if (matchedAccountIds.length > 1) {
    // Attendees belong to multiple accounts: ambiguous, do not guess
    return null;
  }

  // Domain fallback
  const domains = [
    ...new Set(
      normalized
        .map((e) => extractDomain(e))
        .filter((d): d is string => d !== null && d.length > 0),
    ),
  ];

  if (domains.length === 0) return null;

  for (const domain of domains) {
    const accounts = await tx.account.findMany({
      where: {
        workspaceId,
        domain: { equals: domain, mode: "insensitive" },
      },
      select: { id: true },
    });
    if (accounts.length === 1) {
      return accounts[0]!.id;
    }
  }

  return null;
}

/**
 * Ingests calendar meetings (Google Calendar, Microsoft Calendar).
 * Unmatched meetings are created with accountId = null (never guessed).
 */
export async function ingestMeetings(
  run: IngestRunContext,
  meetings: NormalizedMeeting[],
): Promise<void> {
  const { tx, target } = run;
  const meetingRefs = await run.refs("Meeting", meetings.map((m) => m.externalId));

  for (const m of meetings) {
    let accountId: string | null = null;
    if (m.accountExternalId) {
      const accRefs = await run.refs("Account", [m.accountExternalId]);
      accountId = accRefs.get(m.accountExternalId) ?? null;
    }

    if (!accountId) {
      const emails = [
        ...m.attendees.map((a) => a.email),
        ...(m.organizerEmail ? [m.organizerEmail] : []),
      ];
      accountId = await matchAccountFromEmails(tx, target.workspaceId, emails);
    }

    // Resolve organizer user if known
    let organizerUserId: string | null = null;
    if (m.organizerEmail) {
      const user = await tx.user.findFirst({
        where: { email: { equals: m.organizerEmail, mode: "insensitive" } },
        select: { id: true },
      });
      organizerUserId = user?.id ?? null;
    }

    const existingId = meetingRefs.get(m.externalId);
    let meetingId: string;

    if (existingId) {
      const current = await tx.meeting.findUnique({
        where: { id: existingId },
        select: { title: true, startsAt: true, endsAt: true, status: true, accountId: true },
      });
      const changed =
        !current ||
        current.title !== m.title ||
        current.startsAt.getTime() !== m.startsAt.getTime() ||
        current.endsAt.getTime() !== m.endsAt.getTime() ||
        current.status !== m.status ||
        current.accountId !== accountId;

      if (changed) {
        await tx.meeting.update({
          where: { id: existingId },
          data: {
            title: m.title,
            startsAt: m.startsAt,
            endsAt: m.endsAt,
            status: m.status,
            accountId,
            organizerUserId,
          },
        });
        run.counts.updated++;
      } else {
        run.counts.unchanged++;
      }
      meetingId = existingId;
    } else {
      const created = await tx.meeting.create({
        data: {
          workspaceId: target.workspaceId,
          accountId,
          externalId: m.externalId,
          title: m.title,
          startsAt: m.startsAt,
          endsAt: m.endsAt,
          source: target.source,
          status: m.status,
          organizerUserId,
        },
      });
      meetingId = created.id;
      await run.addRefs("Meeting", "Meeting", [[m.externalId, created.id]]);
      run.counts.created++;
    }

    // Process attendees
    for (const att of m.attendees) {
      const emailLower = att.email.toLowerCase().trim();
      const contact = await tx.contact.findFirst({
        where: {
          workspaceId: target.workspaceId,
          email: { equals: emailLower, mode: "insensitive" },
        },
        select: { id: true },
      });

      const user = await tx.user.findFirst({
        where: { email: { equals: emailLower, mode: "insensitive" } },
        select: { id: true },
      });

      await tx.meetingAttendee.upsert({
        where: {
          workspaceId_meetingId_email: {
            workspaceId: target.workspaceId,
            meetingId,
            email: emailLower,
          },
        },
        create: {
          workspaceId: target.workspaceId,
          meetingId,
          email: emailLower,
          name: att.name ?? null,
          responseStatus: att.responseStatus,
          contactId: contact?.id ?? null,
          userId: user?.id ?? null,
        },
        update: {
          name: att.name ?? null,
          responseStatus: att.responseStatus,
          contactId: contact?.id ?? null,
          userId: user?.id ?? null,
        },
      });
    }

    if (accountId) {
      run.accountIds.add(accountId);
    }
  }
}

/**
 * Ingests call transcripts (Fireflies, Gong, Zoom).
 * Maps to CallTranscript + Conversation through ExternalRef.
 */
export async function ingestTranscripts(
  run: IngestRunContext,
  transcripts: NormalizedTranscript[],
): Promise<void> {
  const { tx, target } = run;
  const transcriptRefs = await run.refs("CallTranscript", transcripts.map((t) => t.externalId));

  for (const t of transcripts) {
    if (transcriptRefs.has(t.externalId)) {
      run.counts.unchanged++;
      continue;
    }

    let accountId: string | null = null;
    if (t.accountExternalId) {
      const accRefs = await run.refs("Account", [t.accountExternalId]);
      accountId = accRefs.get(t.accountExternalId) ?? null;
    }

    let linkedMeetingId: string | null = null;
    if (t.meetingExternalId) {
      const meeting = await tx.meeting.findFirst({
        where: {
          workspaceId: target.workspaceId,
          externalId: t.meetingExternalId,
        },
        select: { id: true, accountId: true },
      });
      if (meeting) {
        linkedMeetingId = meeting.id;
        if (!accountId) {
          accountId = meeting.accountId;
        }
      }
    }

    if (!accountId && t.attendeeEmails.length > 0) {
      accountId = await matchAccountFromEmails(tx, target.workspaceId, t.attendeeEmails);
    }

    if (!accountId) {
      run.problem({
        kind: "UNMATCHED",
        objectType: "CallTranscript",
        externalId: t.externalId,
        reason: `Transcript "${t.title}" could not be matched to an account.`,
      });
      continue;
    }

    // Find or create conversation for the call
    const conversation = await tx.conversation.create({
      data: {
        workspaceId: target.workspaceId,
        accountId,
        channel: "CALL",
        subject: t.title,
        startedAt: t.occurredAt,
        lastMessageAt: t.occurredAt,
        source: target.source,
      },
    });

    const segmentsJson =
      t.segments !== undefined ? (t.segments as Prisma.InputJsonValue) : Prisma.JsonNull;

    const transcript = await tx.callTranscript.create({
      data: {
        workspaceId: target.workspaceId,
        conversationId: conversation.id,
        accountId,
        title: t.title,
        provider: target.source,
        language: t.language,
        occurredAt: t.occurredAt,
        text: t.text,
        segments: segmentsJson,
        durationSec: t.durationSec ?? null,
        source: target.source,
      },
    });

    await run.addRefs("CallTranscript", "CallTranscript", [[t.externalId, transcript.id]]);

    if (linkedMeetingId) {
      await tx.meeting.update({
        where: { id: linkedMeetingId },
        data: { conversationId: conversation.id },
      });
    }

    run.counts.created++;
    run.accountIds.add(accountId);
  }
}
