import { z } from "zod";
import type { ScopedDb } from "@/lib/db/scoped";
import { formatCalendarDate } from "@/lib/format";
import { requestApproval } from "@/modules/approvals/service";
import { defineAgent } from "../define";
import { baseAgentOutput, type ContextBundle, type ContextRecord } from "../schemas";
import { jobTier } from "@/lib/ai/routing";

/**
 * Outreach Agent, basic form (spec §6E11, D-30; M4): one check-in email for one CSM-requested
 * intent, drafted from a signal or a ticket. It never sends: its only action is an Approval at
 * DRAFT_FOR_APPROVAL with the draft as version 1 and its citations as proof (Rule 3). M8 extends
 * this same agent with play-step intents and voice samples.
 */
export const outreachOutput = z.object({
  ...baseAgentOutput.shape,
  subject: z.string().min(1).max(200).nullable(),
  body: z.string().min(1).max(4_000).nullable(),
});
export type OutreachOutput = z.infer<typeof outreachOutput>;

export const outreachInput = z.object({
  sourceType: z.enum(["Signal", "Ticket"]).optional(),
  sourceId: z.string().min(1).optional(),
  contactId: z.string().min(1),
  requestedByMembershipId: z.string().min(1).optional(),
  /** One request per click: a new nonce is a new request; a retry of the same one is not. */
  nonce: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  playStepKey: z.string().optional(),
  intent: z.string().optional(),
});
export type OutreachInput = z.infer<typeof outreachInput>;

const day = (d: Date | null) => (d ? formatCalendarDate(d) : null);

/** The record a check-in is about, its account, and the customer's own recent words on it. */
export async function checkInSource(
  db: ScopedDb,
  input: Pick<OutreachInput, "sourceType" | "sourceId">,
): Promise<{
  accountId: string;
  record: ContextRecord;
  messages: Array<{ id: string; bodyText: string; sentAt: Date }>;
  label: string;
} | null> {
  if (!input.sourceType || !input.sourceId) return null;
  if (input.sourceType === "Signal") {
    const s = await db.signal.findUnique({ where: { id: input.sourceId } });
    if (!s) return null;
    return {
      accountId: s.accountId,
      record: {
        sourceType: "Signal",
        sourceId: s.id,
        fields: {
          title: s.title,
          explanation: s.explanation,
          severity: s.severity.toLowerCase(),
          firstSeen: day(s.firstSeenAt),
        },
      },
      messages: [],
      label: s.title,
    };
  }
  const t = await db.ticket.findUnique({ where: { id: input.sourceId } });
  if (!t) return null;
  const messages = t.conversationId
    ? await db.message.findMany({
        where: { conversationId: t.conversationId, direction: "INBOUND" },
        orderBy: { sentAt: "desc" },
        take: 3,
        select: { id: true, bodyText: true, sentAt: true },
      })
    : [];
  return {
    accountId: t.accountId,
    record: {
      sourceType: "Ticket",
      sourceId: t.id,
      fields: {
        subject: t.subject,
        status: t.status.toLowerCase(),
        priority: t.priority.toLowerCase(),
        opened: day(t.openedAt),
      },
    },
    messages,
    label: `Ticket: ${t.subject}`,
  };
}

export const outreach = defineAgent({
  key: "outreach",
  version: "1.1.0",
  description:
    "Drafts one check-in email for a CSM-requested or play intent; every draft goes to Approvals",
  modelTier: jobTier("outreach"),
  tierReason: "A short customer-facing draft: tone and accuracy matter, depth does not (§6.1).",
  prompt: { name: "outreach", version: "1.1.0" },
  inputSchema: outreachInput,
  outputSchema: outreachOutput,
  async buildContext(db, input) {
    const [src, contact, csm, voiceSamples] = await Promise.all([
      checkInSource(db, input),
      db.contact.findUnique({ where: { id: input.contactId } }),
      input.requestedByMembershipId
        ? db.membership.findUnique({
            where: { id: input.requestedByMembershipId },
            include: { user: { select: { name: true } } },
          })
        : null,
      db.voiceSample.findMany({
        where: { approvedForVoice: true },
        take: 3,
        orderBy: { createdAt: "desc" },
        select: { subject: true, bodyText: true },
      }),
    ]);
    const voiceExamples =
      voiceSamples.length > 0
        ? voiceSamples.map((s) => `Subject: ${s.subject}\n\n${s.bodyText}`).join("\n\n---\n\n")
        : "None on file; use default tone.";

    const targetAccountId = src?.accountId ?? input.accountId ?? contact?.accountId;
    if (!targetAccountId || !contact || contact.accountId !== targetAccountId)
      return {
        bundle: [],
        vars: {
          csmName: "the CSM",
          contactName: "the customer",
          accountName: "the account",
          voiceExamples,
        },
      };
    const account = await db.account.findUniqueOrThrow({
      where: { id: targetAccountId },
      select: { id: true, name: true },
    });
    const bundle: ContextBundle = [
      ...(src ? [src.record] : []),
      { sourceType: "Account", sourceId: account.id, fields: { name: account.name } },
      {
        sourceType: "Contact",
        sourceId: contact.id,
        fields: { name: contact.name, title: contact.title ?? null },
      },
      ...(src
        ? src.messages.map((m) => ({
            sourceType: "Message" as const,
            sourceId: m.id,
            fields: { text: m.bodyText, sent: day(m.sentAt) },
          }))
        : []),
    ];
    return {
      bundle,
      accountId: account.id,
      vars: {
        csmName: csm?.user.name ?? "the CSM",
        contactName: contact.name,
        accountName: account.name,
        voiceExamples,
      },
    };
  },
  narrative: (o) => [o.subject ?? "", o.body ?? ""],
  forbiddenNumericFields: ["confidence", "amountMinor"],
  approvalPolicy: {
    HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
    MID_TOUCH: "DRAFT_FOR_APPROVAL",
    LONG_TAIL: "DRAFT_FOR_APPROVAL",
  },
  async act(output, ctx) {
    if (!output.subject || !output.body || !ctx.accountId)
      return { effects: [], actionTaken: "NONE" };
    const input = ctx.input as OutreachInput;
    const record = ctx.bundle[0] ?? { sourceType: "Account", sourceId: ctx.accountId, fields: {} };
    const proposerId = input.requestedByMembershipId;
    const approval = await requestApproval(ctx, {
      accountId: ctx.accountId,
      kind: "SEND_EMAIL",
      reason: `Check-in about: ${String(record.fields.title ?? record.fields.subject ?? record.fields.name ?? "this account")}`,
      proof: output.citations.map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId })),
      signalId: record.sourceType === "Signal" ? record.sourceId : undefined,
      proposedByAgentRunId: ctx.runId,
      proposedByMembershipId: proposerId,
      triggeringText: ctx.bundle
        .filter((r) => r.sourceType === "Message")
        .map((r) => String(r.fields.text ?? "")),
      sourceKey: ctx.sourceKey(0),
      email: {
        contactId: input.contactId,
        subject: output.subject,
        body: output.body,
        origin: "AI",
        agentRunId: ctx.runId,
      },
    });
    const message = await ctx.db.outboundMessage.findFirst({
      where: { approvalId: approval.id },
      select: { id: true },
    });
    return {
      effects: [
        { type: "Approval", id: approval.id },
        ...(message ? [{ type: "OutboundMessage", id: message.id }] : []),
      ],
      actionTaken: "APPROVAL_REQUESTED",
    };
  },
});
