import { z } from "zod";
import { addDays, businessClock, todayIn } from "@/lib/dates";
import type { ScopedDb, TenantContext } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { formatCalendarDate } from "@/lib/format";
import { requestApproval } from "@/modules/approvals/service";
import { validateNarrative } from "@/modules/documents/service";
import { defineAgent } from "../define";
import {
  baseAgentOutput,
  proposedActionSchema,
  type ContextBundle,
  type ContextRecord,
} from "../schemas";
import { firstEmailContact } from "./draft-support";

/**
 * Expansion Finder (spec §6E9, M7 §2): for one expansion opportunity, a short note for the CSM and
 * one conversation draft for the customer, "never a hard pitch with no proof".
 *
 * It cites the usage and limit records it was given (the signals, the contract's limits, usage
 * rows). The estimate is never the model's: the opportunity's own figure (from the account's own
 * subscription, `estimate.ts`) is not in the bundle, so the model cannot repeat it; where the note
 * mentions size it writes `{{metric.expansion.estimate}}` and code renders it, labelled with its
 * method, or "Restricted" for a reader without revenue access. The customer draft carries no
 * placeholder at all. The only effect is an Approval (Rule 3): nothing is sent.
 */
const NUMERIC = ["estimate"] as const;
export const ESTIMATE_KEY = "expansion.estimate";

export const expansionFinderInput = z.object({ opportunityId: z.string().min(1) });
export type ExpansionFinderInput = z.infer<typeof expansionFinderInput>;

export const expansionFinderOutput = z
  .object({
    ...baseAgentOutput.shape,
    proposedActions: z
      .array(proposedActionSchema.extend({ estimate: z.number().optional() }))
      .default([]),
    narrative: z.string().min(1).max(1_200).nullable(),
    conversation: z.object({
      subject: z.string().min(1).max(200).nullable(),
      body: z.string().min(1).max(4_000).nullable(),
    }),
  })
  .superRefine((o, ctx) => {
    const block = (id: string, text: string | null) =>
      text === null ? [] : [{ id, type: "paragraph" as const, text }];
    // The note may carry the estimate placeholder and nothing else in braces; the draft, none.
    for (const p of validateNarrative(
      block("narrative", o.narrative),
      [ESTIMATE_KEY],
      {},
      { numbers: "allow" },
    ))
      ctx.addIssue({ code: "custom", message: p.message, path: ["narrative"] });
    const draft = [
      ...block("subject", o.conversation.subject),
      ...block("body", o.conversation.body),
    ];
    for (const p of validateNarrative(draft, [], {}, { numbers: "allow" }))
      ctx.addIssue({ code: "custom", message: p.message, path: ["conversation"] });
  });
export type ExpansionFinderOutput = z.infer<typeof expansionFinderOutput>;

export async function expansionFinderContext(
  db: ScopedDb,
  input: ExpansionFinderInput,
  ctx: TenantContext,
) {
  const empty = {
    bundle: [] as ContextBundle,
    vars: { csmName: "the CSM", contactName: "the customer", accountName: "the account" },
  };
  const opp = await db.expansionOpportunity.findUnique({
    where: { id: input.opportunityId },
    select: {
      id: true,
      status: true,
      signalIds: true,
      estimateMinor: true,
      accountId: true,
      account: { select: { name: true, ownerMembershipId: true } },
    },
  });
  if (!opp || opp.status === "WON" || opp.status === "LOST" || opp.status === "DISMISSED")
    return empty;
  const ws = await getOwnWorkspace(ctx);
  const asOf = todayIn(ws.timezone, businessClock);
  const [signals, contract, usage, goals, owner, contact] = await Promise.all([
    db.signal.findMany({
      where: { id: { in: opp.signalIds } },
      select: { id: true, ruleKey: true, title: true, explanation: true },
      orderBy: { id: "asc" },
    }),
    db.contract.findFirst({
      where: {
        accountId: opp.accountId,
        status: "ACTIVE",
        startDate: { lte: new Date(`${asOf}T00:00:00Z`) },
      },
      orderBy: { startDate: "desc" },
      select: { id: true, seatsPurchased: true, creditsPurchased: true },
    }),
    db.usageDaily.findMany({
      where: {
        accountId: opp.accountId,
        date: {
          gte: new Date(`${addDays(asOf, -7)}T00:00:00Z`),
          lt: new Date(`${asOf}T00:00:00Z`),
        },
      },
      orderBy: { date: "desc" },
      take: 2,
      select: { id: true, date: true, activeUsers: true, seatsUsed: true, creditsUsed: true },
    }),
    db.goal.findMany({
      where: { accountId: opp.accountId, status: "OPEN", metricKey: { in: ["seats", "users"] } },
      select: { id: true, text: true, targetValue: true },
    }),
    opp.account.ownerMembershipId
      ? db.membership.findUnique({
          where: { id: opp.account.ownerMembershipId },
          include: { user: { select: { name: true } } },
        })
      : Promise.resolve(null),
    firstEmailContact(db, opp.accountId, null),
  ]);
  const bundle: ContextBundle = [
    {
      sourceType: "ExpansionOpportunity",
      sourceId: opp.id,
      fields: { account: opp.account.name, status: opp.status.toLowerCase().replace("_", " ") },
    },
    ...signals.map((s): ContextRecord => ({
      sourceType: "Signal",
      sourceId: s.id,
      fields: { rule: s.ruleKey, title: s.title, explanation: s.explanation },
    })),
    ...(contract
      ? [
          {
            sourceType: "Contract",
            sourceId: contract.id,
            fields: {
              seatsPurchased: contract.seatsPurchased,
              creditsPurchased: contract.creditsPurchased,
            },
          } satisfies ContextRecord,
        ]
      : []),
    ...usage.map((u): ContextRecord => ({
      sourceType: "UsageDaily",
      sourceId: u.id,
      fields: {
        date: formatCalendarDate(u.date),
        activeUsers: u.activeUsers,
        seatsUsed: u.seatsUsed,
        creditsUsed: u.creditsUsed,
      },
    })),
    ...goals.map((g): ContextRecord => ({
      sourceType: "Goal",
      sourceId: g.id,
      fields: { text: g.text, targetValue: g.targetValue },
    })),
    ...(contact
      ? [
          {
            sourceType: "Contact",
            sourceId: contact.id,
            fields: { name: contact.name, title: contact.title ?? null },
          } satisfies ContextRecord,
        ]
      : []),
  ];
  return {
    bundle,
    accountId: opp.accountId,
    vars: {
      csmName: owner?.user.name ?? "the CSM",
      contactName: contact?.name ?? "the customer",
      accountName: opp.account.name,
    },
    // The deterministic value that overwrites a model-supplied estimate in a proposed action.
    facts: (opp.estimateMinor !== null ? { estimate: Number(opp.estimateMinor) } : {}) as Record<
      string,
      number
    >,
  };
}

export const expansionFinder = defineAgent({
  key: "expansion-finder",
  version: "1.0.0",
  description:
    "Explains an expansion opportunity from usage and limit records and drafts a conversation, never a hard pitch; the draft goes to Approvals",
  modelTier: "standard",
  tierReason:
    "A short note and one customer-facing draft from a few records: tone and accuracy matter (§6.1).",
  prompt: { name: "expansion-finder", version: "1.0.0" },
  inputSchema: expansionFinderInput,
  outputSchema: expansionFinderOutput,
  buildContext: expansionFinderContext,
  narrative: (o) => [
    o.reasoningSummary,
    o.narrative ?? "",
    o.conversation.subject ?? "",
    o.conversation.body ?? "",
  ],
  forbiddenNumericFields: NUMERIC,
  approvalPolicy: {
    HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
    MID_TOUCH: "DRAFT_FOR_APPROVAL",
    LONG_TAIL: "DRAFT_FOR_APPROVAL",
  },
  async act(output, ctx) {
    const opp = ctx.bundle.find((r) => r.sourceType === "ExpansionOpportunity");
    const contact = ctx.bundle.find((r) => r.sourceType === "Contact");
    if (
      !opp ||
      !ctx.accountId ||
      !output.conversation.subject ||
      !output.conversation.body ||
      !contact
    )
      return { effects: [], actionTaken: "NONE" };
    const approval = await requestApproval(ctx, {
      accountId: ctx.accountId,
      kind: "SEND_EMAIL",
      reason: `Expansion conversation: ${ctx.bundle.find((r) => r.sourceType === "Signal")?.fields.title ?? "usage is above the plan"}`,
      proof: output.citations.map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId })),
      proposedByAgentRunId: ctx.runId,
      triggeringText: [],
      sourceKey: ctx.sourceKey(0),
      email: {
        contactId: contact.sourceId,
        subject: output.conversation.subject,
        body: output.conversation.body,
        origin: "AI",
        agentRunId: ctx.runId,
      },
    });
    const effects = [{ type: "Approval", id: approval.id }];
    const message = await ctx.db.outboundMessage.findFirst({
      where: { approvalId: approval.id },
      select: { id: true },
    });
    if (message) effects.push({ type: "OutboundMessage", id: message.id });
    return { effects, actionTaken: "APPROVAL_REQUESTED" };
  },
});
