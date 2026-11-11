import { z } from "zod";
import { formatCalendarDate } from "@/lib/format";
import { requestApproval } from "@/modules/approvals/service";
import { defineAgent } from "../define";
import { baseAgentOutput, type ContextBundle, type ContextRecord } from "../schemas";
import { jobTier } from "@/lib/ai/routing";

export const digitalCsmOutput = z.object({
  ...baseAgentOutput.shape,
  subject: z.string().min(1).max(200).nullable(),
  body: z.string().min(1).max(4_000).nullable(),
  handedOff: z.boolean().default(false),
  handoffReason: z.string().nullable().default(null),
});
export type DigitalCsmOutput = z.infer<typeof digitalCsmOutput>;

export const digitalCsmInput = z.object({
  accountId: z.string().min(1),
  contactId: z.string().min(1),
  stepKey: z.string().optional(),
  playId: z.string().optional(),
  playRunId: z.string().optional(),
  triggerRef: z.string().optional(),
  signalId: z.string().optional(),
  topic: z.string().optional(),
  contextNotes: z.string().optional(),
});
export type DigitalCsmInput = z.infer<typeof digitalCsmInput>;

const SENSITIVE_REGEX =
  /\b(cancel|cancellation|refund|lawyer|attorney|legal|sue|lawsuit|breach|discount|pricing|price\s*increase|dispute|angry|furious|terrible|unacceptable)\b/i;

const day = (d: Date | null) => (d ? formatCalendarDate(d) : null);

export const digitalCsm = defineAgent({
  key: "digital-csm",
  version: "1.0.0",
  description:
    "Runs safe play steps for long-tail accounts; immediately hands off to human on risk, anger, pricing, or legal topics",
  modelTier: jobTier("digital-csm"),
  tierReason: "Standard long-tail customer communication with strict rule-based and content-based hand-off boundaries (§8).",
  prompt: { name: "digital-csm", version: "1.0.0" },
  inputSchema: digitalCsmInput,
  outputSchema: digitalCsmOutput,
  async buildContext(db, input) {
    const [account, contact] = await Promise.all([
      db.account.findUnique({
        where: { id: input.accountId },
        include: { owner: { include: { user: { select: { name: true, email: true } } } } },
      }),
      db.contact.findUnique({ where: { id: input.contactId } }),
    ]);

    if (!account || !contact || contact.accountId !== account.id) {
      return {
        bundle: [],
        vars: { accountName: "the account", contactName: "the contact", handOffDetected: "" },
      };
    }

    // Fetch active signals, recent tickets, recent messages, and extractions
    const [signals, tickets, messages] = await Promise.all([
      db.signal.findMany({
        where: { accountId: account.id, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        orderBy: { firstSeenAt: "desc" },
        take: 5,
      }),
      db.ticket.findMany({
        where: { accountId: account.id, status: { in: ["OPEN", "PENDING"] } },
        orderBy: { openedAt: "desc" },
        take: 3,
      }),
      db.message.findMany({
        where: { accountId: account.id, direction: "INBOUND" },
        orderBy: { sentAt: "desc" },
        take: 5,
      }),
    ]);

    const bundle: ContextBundle = [
      {
        sourceType: "Account",
        sourceId: account.id,
        fields: { name: account.name, tier: account.tier },
      },
      {
        sourceType: "Contact",
        sourceId: contact.id,
        fields: { name: contact.name, title: contact.title ?? null, email: contact.email },
      },
      ...signals.map(
        (s): ContextRecord => ({
          sourceType: "Signal",
          sourceId: s.id,
          fields: {
            title: s.title,
            explanation: s.explanation,
            severity: s.severity.toLowerCase(),
            polarity: s.polarity,
            ruleKey: s.ruleKey,
          },
        }),
      ),
      ...tickets.map(
        (t): ContextRecord => ({
          sourceType: "Ticket",
          sourceId: t.id,
          fields: {
            subject: t.subject,
            priority: t.priority.toLowerCase(),
            status: t.status.toLowerCase(),
          },
        }),
      ),
      ...messages.map(
        (m): ContextRecord => ({
          sourceType: "Message",
          sourceId: m.id,
          fields: { text: m.bodyText, sent: day(m.sentAt) },
        }),
      ),
    ];

    // Check hand-off conditions in records
    const hasRiskSignal = signals.some((s) => s.polarity === "RISK" && s.severity !== "INFO");
    const hasSensitiveMessage = messages.some((m) => SENSITIVE_REGEX.test(m.bodyText));
    const hasUrgentTicket = tickets.some((t) => t.priority === "URGENT" || SENSITIVE_REGEX.test(t.subject));
    const handOffFlag = hasRiskSignal || hasSensitiveMessage || hasUrgentTicket;

    return {
      bundle,
      accountId: account.id,
      vars: {
        accountName: account.name,
        contactName: contact.name,
        handOffDetected: handOffFlag ? "YES" : "NO",
      },
    };
  },
  narrative: (o) => [o.subject ?? "", o.body ?? "", o.handoffReason ?? ""],
  forbiddenNumericFields: ["confidence"],
  approvalPolicy: {
    HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
    MID_TOUCH: "DRAFT_FOR_APPROVAL",
    LONG_TAIL: "DRAFT_FOR_APPROVAL",
  },
  async act(output, ctx) {
    if (!ctx.accountId) return { effects: [], actionTaken: "NONE" };
    const input = ctx.input as DigitalCsmInput;

    // Check if input or bundle contains sensitive triggers that force hand-off even if output didn't flag it
    const messages = ctx.bundle.filter((r) => r.sourceType === "Message");
    const signals = ctx.bundle.filter((r) => r.sourceType === "Signal");
    const sensitiveFound = messages.some((m) => SENSITIVE_REGEX.test(String(m.fields.text ?? "")));
    const riskSignalFound = signals.some((s) => s.fields.polarity === "RISK" && s.fields.severity !== "info");

    const mustHandOff = output.handedOff || sensitiveFound || riskSignalFound;
    const handoffReason =
      output.handoffReason ??
      (sensitiveFound
        ? "Customer communication contains sensitive topic (pricing, legal, dispute, or complaint)."
        : riskSignalFound
        ? "Active risk signal present on account."
        : "Risk or complex request detected.");

    if (mustHandOff) {
      // Find account owner or CS Leader/Admin
      const account = await ctx.db.account.findUnique({
        where: { id: ctx.accountId },
        select: { ownerMembershipId: true },
      });

      let ownerId = account?.ownerMembershipId;
      if (!ownerId) {
        const leader = await ctx.db.membership.findFirst({
          where: { role: { in: ["CS_LEADER", "ADMIN"] }, status: "ACTIVE" },
          select: { id: true },
        });
        ownerId = leader?.id;
      }

      // Safe signal validation
      let signalId: string | null = null;
      if (input.signalId) {
        const s = await ctx.db.signal.findUnique({ where: { id: input.signalId }, select: { id: true } });
        if (s) signalId = s.id;
      }
      if (!signalId) {
        const s = ctx.bundle.find((r) => r.sourceType === "Signal")?.sourceId;
        if (s) {
          const found = await ctx.db.signal.findUnique({ where: { id: s }, select: { id: true } });
          if (found) signalId = found.id;
        }
      }

      const effects: Array<{ type: string; id: string }> = [];

      if (ownerId) {
        const task = await ctx.db.task.create({
          data: {
            workspaceId: ctx.workspaceId,
            accountId: ctx.accountId,
            signalId,
            title: `Hand-off: ${handoffReason}`.slice(0, 200),
            detail: `Digital CSM detected conditions requiring human intervention: ${handoffReason}`,
            ownerMembershipId: ownerId,
            priority: "HIGH",
            origin: "AI",
            agentRunId: ctx.runId,
            source: "SYSTEM",
          },
        });
        effects.push({ type: "Task", id: task.id });
      }

      if (output.subject && output.body) {
        const approval = await requestApproval(ctx, {
          accountId: ctx.accountId,
          kind: "SEND_EMAIL",
          reason: `Digital CSM hand-off draft: ${handoffReason}`,
          proof: output.citations.map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId })),
          signalId: signalId ?? undefined,
          proposedByAgentRunId: ctx.runId,
          proposedByMembershipId: ownerId,
          triggeringText: [handoffReason, ...messages.map((m) => String(m.fields.text ?? ""))],
          sourceKey: ctx.sourceKey(0),
          email: {
            contactId: input.contactId,
            subject: output.subject,
            body: output.body,
            origin: "AI",
            agentRunId: ctx.runId,
          },
        });
        effects.push({ type: "Approval", id: approval.id });
      }

      return {
        effects,
        actionTaken: "TASK_CREATED",
      };
    }

    // Normal safe execution: draft to Approvals
    if (!output.subject || !output.body) {
      return { effects: [], actionTaken: "NONE" };
    }

    const account = await ctx.db.account.findUnique({
      where: { id: ctx.accountId },
      select: { ownerMembershipId: true },
    });

    const approval = await requestApproval(ctx, {
      accountId: ctx.accountId,
      kind: "SEND_EMAIL",
      reason: "Digital CSM check-in draft",
      proof: output.citations.map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId })),
      proposedByAgentRunId: ctx.runId,
      proposedByMembershipId: account?.ownerMembershipId ?? undefined,
      triggeringText: messages.map((m) => String(m.fields.text ?? "")),
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
