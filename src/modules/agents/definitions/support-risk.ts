import { z } from "zod";
import { requestApproval } from "@/modules/approvals/service";
import { currentExtractions } from "@/modules/conversations/service";
import { inboxRowFor } from "@/modules/inbox/service";
import { detectSensitive } from "@/modules/outbound/service";
import { defineAgent } from "../define";
import { baseAgentOutput, type ContextBundle } from "../schemas";
import { jobTier } from "@/lib/ai/routing";

/**
 * Support Risk Agent (spec §6E6, M9 B2): a risk narrative on one inbound email or ticket, and the
 * reply draft for the Inbox. It sends nothing: its only action is an Approval (SEND_EMAIL at
 * DRAFT_FOR_APPROVAL, the draft as version 1) with the customer's own words as proof (Rule 3).
 *
 * The sensitive gate holds by construction, not convention: the agent runs its own sensitive
 * check over what the customer wrote, the reply and what the Watcher read, passes the reasons to
 * the approval as tags, and refuses to continue if the stored approval is not sensitive and
 * capped at DRAFT_FOR_APPROVAL (which the database also enforces: approval_sensitive_cap).
 */
export const supportRiskOutput = z.object({
  ...baseAgentOutput.shape,
  riskNarrative: z.string().min(1).max(800),
  reply: z
    .object({ subject: z.string().min(1).max(200), body: z.string().min(1).max(4_000) })
    .nullable(),
});
export type SupportRiskOutput = z.infer<typeof supportRiskOutput>;

export const supportRiskInput = z.object({
  inboxItemId: z.string().min(1),
  requestedByMembershipId: z.string().min(1).optional(),
  /** One request per click: a new nonce is a new request; a retry of the same one is not. */
  nonce: z.string().min(1).optional(),
});
export type SupportRiskInput = z.infer<typeof supportRiskInput>;

const CUSTOMER_WORDS = new Set(["Message", "Ticket"]);
const EVIDENCE = new Set(["Message", "Ticket", "Extraction"]);

export const supportRisk = defineAgent({
  key: "support-risk",
  version: "1.0.0",
  description:
    "Explains the risk in one inbound email or ticket and drafts the reply for the Inbox; every draft goes to Approvals",
  modelTier: jobTier("support-risk"),
  tierReason:
    "A short customer-facing draft plus a judgement on risk: tone and accuracy matter (§6.1).",
  prompt: { name: "support-risk", version: "1.0.0" },
  inputSchema: supportRiskInput,
  outputSchema: supportRiskOutput,
  async buildContext(db, input, ctx) {
    const item = await db.inboxItem.findUnique({ where: { id: input.inboxItemId } });
    const none = {
      bundle: [] as ContextBundle,
      vars: { csmName: "the CSM", contactName: "the customer", accountName: "the account" },
    };
    if (!item) return none;
    const [account, row, csm] = await Promise.all([
      db.account.findUniqueOrThrow({
        where: { id: item.accountId },
        select: { id: true, name: true },
      }),
      inboxRowFor(ctx, item.id),
      input.requestedByMembershipId
        ? db.membership.findUnique({
            where: { id: input.requestedByMembershipId },
            include: { user: { select: { name: true } } },
          })
        : null,
    ]);
    // The customer's words: the message, or a ticket's latest inbound messages.
    let customerMessages: Array<{
      id: string;
      bodyText: string;
      sentAt: Date;
      fromContactId: string | null;
    }> = [];
    let ticketRecord: ContextBundle[number] | null = null;
    let contactId: string | null = null;
    if (item.sourceType === "MESSAGE") {
      const m = await db.message.findUnique({
        where: { id: item.sourceId },
        select: { id: true, bodyText: true, sentAt: true, fromContactId: true, subject: true },
      });
      if (m) {
        customerMessages = [m];
        contactId = m.fromContactId;
      }
    } else {
      const t = await db.ticket.findUnique({ where: { id: item.sourceId } });
      if (t) {
        ticketRecord = {
          sourceType: "Ticket",
          sourceId: t.id,
          fields: {
            subject: t.subject,
            status: t.status.toLowerCase(),
            priority: t.priority.toLowerCase(),
          },
        };
        contactId = t.contactId;
        customerMessages = t.conversationId
          ? await db.message.findMany({
              where: { conversationId: t.conversationId, direction: "INBOUND" },
              orderBy: { sentAt: "desc" },
              take: 3,
              select: { id: true, bodyText: true, sentAt: true, fromContactId: true },
            })
          : [];
        contactId =
          contactId ?? customerMessages.find((m) => m.fromContactId)?.fromContactId ?? null;
      }
    }
    const [contact, read, related] = await Promise.all([
      contactId ? db.contact.findUnique({ where: { id: contactId } }) : null,
      currentExtractions(db, {
        accountIds: [account.id],
        sourceType: "MESSAGE",
        sourceIds: customerMessages.map((m) => m.id),
      }),
      row ? Promise.resolve(row.relatedTickets) : Promise.resolve([]),
    ]);
    const bundle: ContextBundle = [
      { sourceType: "Account", sourceId: account.id, fields: { name: account.name } },
      ...(ticketRecord ? [ticketRecord] : []),
      ...customerMessages.map((m) => ({
        sourceType: "Message" as const,
        sourceId: m.id,
        fields: { text: m.bodyText, sent: m.sentAt.toISOString().slice(0, 10) },
      })),
      ...read.map((r) => ({
        sourceType: "Extraction" as const,
        sourceId: r.id,
        fields: {
          kind: r.kind.toLowerCase(),
          quote: r.quote,
          ...(r.payload as Record<string, string>),
        },
      })),
      ...related.map((t) => ({
        sourceType: "Ticket" as const,
        sourceId: t.id,
        fields: { subject: t.subject, note: "another ticket on the same problem" },
      })),
      ...(contact
        ? [{ sourceType: "Contact" as const, sourceId: contact.id, fields: { name: contact.name } }]
        : []),
    ];
    return {
      bundle,
      accountId: account.id,
      vars: {
        csmName: csm?.user.name ?? "the CSM",
        contactName: contact?.name ?? "the customer",
        accountName: account.name,
      },
    };
  },
  narrative: (o) => [o.riskNarrative, o.reply?.subject ?? "", o.reply?.body ?? ""],
  uncited: (o) => [
    ...(o.reply && !o.citations.some((c) => CUSTOMER_WORDS.has(c.sourceType))
      ? ["the reply cites none of the customer's messages or tickets"]
      : []),
    ...(!o.citations.some((c) => EVIDENCE.has(c.sourceType))
      ? ["the risk narrative cites no message, ticket or extraction"]
      : []),
  ],
  forbiddenNumericFields: ["confidence", "amountMinor"],
  approvalPolicy: {
    HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
    MID_TOUCH: "DRAFT_FOR_APPROVAL",
    LONG_TAIL: "DRAFT_FOR_APPROVAL",
  },
  async act(output, ctx) {
    const input = ctx.input as SupportRiskInput;
    const contact = ctx.bundle.find((r) => r.sourceType === "Contact");
    if (!output.reply || !ctx.accountId || !contact) return { effects: [], actionTaken: "NONE" };
    const db = ctx.db;
    const contactRow = await db.contact.findUnique({
      where: { id: contact.sourceId },
      select: { id: true, email: true, status: true },
    });
    if (!contactRow?.email || contactRow.status !== "ACTIVE")
      return { effects: [], actionTaken: "NONE" };

    const customerTexts = ctx.bundle
      .filter((r) => r.sourceType === "Message")
      .map((r) => String(r.fields.text ?? ""));
    const extractions = ctx.bundle
      .filter((r) => r.sourceType === "Extraction")
      .map((r) => ({ kind: String(r.fields.kind).toUpperCase() as never, payload: r.fields }));
    const sens = detectSensitive({
      texts: [...customerTexts, output.reply.subject, output.reply.body],
      extractions,
    });
    const approval = await requestApproval(ctx, {
      accountId: ctx.accountId,
      kind: "SEND_EMAIL",
      reason: `Reply to an inbound message: ${output.riskNarrative}`.slice(0, 500),
      proof: output.citations.map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId })),
      proposedByAgentRunId: ctx.runId,
      proposedByMembershipId: input.requestedByMembershipId,
      triggeringText: customerTexts,
      // The agent's own reasons force the gate even if the approval's own sweep missed them.
      stepTags: sens.reasons,
      sourceKey: ctx.sourceKey(0),
      email: {
        contactId: contactRow.id,
        subject: output.reply.subject,
        body: output.reply.body,
        origin: "AI",
        agentRunId: ctx.runId,
      },
    });
    if (
      sens.isSensitive &&
      (!approval.isSensitive || approval.requiredLevel !== "DRAFT_FOR_APPROVAL")
    )
      throw new Error(
        "Sensitive inbox reply was not capped at DRAFT_FOR_APPROVAL; refusing to continue (Rule 3)",
      );
    const message = await db.outboundMessage.findFirst({
      where: { approvalId: approval.id },
      select: { id: true },
    });
    if (message)
      await db.inboxItem.updateMany({
        where: { id: input.inboxItemId, status: "NEW" },
        data: { status: "DRAFTED", draftOutboundMessageId: message.id },
      });
    return {
      effects: [
        { type: "Approval", id: approval.id },
        ...(message
          ? [
              { type: "OutboundMessage", id: message.id },
              { type: "InboxItem", id: input.inboxItemId },
            ]
          : []),
      ],
      actionTaken: "APPROVAL_REQUESTED",
    };
  },
});
