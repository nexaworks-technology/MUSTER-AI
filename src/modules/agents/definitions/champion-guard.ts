import { z } from "zod";
import { businessClock, todayIn } from "@/lib/dates";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { requestApproval } from "@/modules/approvals/service";
import { championGuardFor } from "@/modules/contacts/service";
import { defineAgent } from "../define";
import { baseAgentOutput, type ContextBundle } from "../schemas";
import { jobTier } from "@/lib/ai/routing";

/**
 * Champion Guard (spec §6E10, M9 B4): when the champion is gone or silent, the records rank the
 * next-best contacts (code, contacts/champion-candidates.ts). This agent only explains one
 * ranked contact and drafts an introduction to them: the model never picks, and the caller cannot
 * name someone the records did not rank (checked in buildContext and again in act). Its one
 * action is an Approval at DRAFT_FOR_APPROVAL; nothing is sent (Rule 3).
 */
export const championGuardOutput = z.object({
  ...baseAgentOutput.shape,
  whyThisPerson: z.string().min(1).max(500),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(4_000),
});

export const championGuardInput = z.object({
  accountId: z.string().min(1),
  candidateContactId: z.string().min(1),
  requestedByMembershipId: z.string().min(1).optional(),
  nonce: z.string().min(1).optional(),
});
export type ChampionGuardInput = z.infer<typeof championGuardInput>;

export const championGuard = defineAgent({
  key: "champion-guard",
  version: "1.0.0",
  description:
    "Explains why a pre-ranked contact is the next-best person to reach and drafts an introduction; every draft goes to Approvals",
  modelTier: jobTier("champion-guard"),
  tierReason: "A short customer-facing draft: tone matters, the ranking is done by code (§6.1).",
  prompt: { name: "champion-guard", version: "1.0.0" },
  inputSchema: championGuardInput,
  outputSchema: championGuardOutput,
  async buildContext(db, input, ctx) {
    const none = {
      bundle: [] as ContextBundle,
      vars: { csmName: "the CSM", accountName: "the account", championName: "the champion" },
    };
    const ws = await getOwnWorkspace(ctx);
    const guard = await championGuardFor(ctx, input.accountId, todayIn(ws.timezone, businessClock));
    const candidate = guard?.candidates.find((c) => c.contactId === input.candidateContactId);
    if (!guard || !candidate) return none;
    const [account, csm] = await Promise.all([
      db.account.findUniqueOrThrow({
        where: { id: input.accountId },
        select: { id: true, name: true },
      }),
      input.requestedByMembershipId
        ? db.membership.findUnique({
            where: { id: input.requestedByMembershipId },
            include: { user: { select: { name: true } } },
          })
        : null,
    ]);
    const bundle: ContextBundle = [
      { sourceType: "Account", sourceId: account.id, fields: { name: account.name } },
      {
        sourceType: "Contact",
        sourceId: guard.champion.contactId,
        fields: {
          name: guard.champion.name,
          why: guard.reason,
          note: "the champion who is gone or silent",
        },
      },
      {
        sourceType: "Contact",
        sourceId: candidate.contactId,
        fields: {
          name: candidate.name,
          title: candidate.title,
          reasons: candidate.reasons.map((r) => r.text).join("; "),
          note: "the contact to write to",
        },
      },
    ];
    return {
      bundle,
      accountId: account.id,
      vars: {
        csmName: csm?.user.name ?? "the CSM",
        accountName: account.name,
        championName: guard.champion.name,
      },
    };
  },
  narrative: (o) => [o.whyThisPerson, o.subject, o.body],
  forbiddenNumericFields: ["confidence", "amountMinor"],
  approvalPolicy: {
    HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
    MID_TOUCH: "DRAFT_FOR_APPROVAL",
    LONG_TAIL: "DRAFT_FOR_APPROVAL",
  },
  async act(output, ctx) {
    const input = ctx.input as ChampionGuardInput;
    if (
      !ctx.accountId ||
      !output.citations.some(
        (c) => c.sourceType === "Contact" && c.sourceId === input.candidateContactId,
      )
    )
      return { effects: [], actionTaken: "NONE" };
    const ws = await getOwnWorkspace({ workspaceId: ctx.workspaceId });
    const guard = await championGuardFor(ctx, ctx.accountId, todayIn(ws.timezone, businessClock));
    const candidate = guard?.candidates.find((c) => c.contactId === input.candidateContactId);
    if (!guard || !candidate) return { effects: [], actionTaken: "NONE" };
    const contact = await ctx.db.contact.findUnique({
      where: { id: candidate.contactId },
      select: { id: true, email: true, status: true },
    });
    if (!contact?.email || contact.status !== "ACTIVE") return { effects: [], actionTaken: "NONE" };
    const approval = await requestApproval(ctx, {
      accountId: ctx.accountId,
      kind: "SEND_EMAIL",
      reason: `Introduce ourselves to ${candidate.name}: ${output.whyThisPerson}`.slice(0, 500),
      proof: [
        ...output.citations.map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId })),
        ...candidate.reasons
          .flatMap((r) => r.sources)
          .filter((s) => s.sourceId)
          .map((s) => ({ sourceType: s.sourceType, sourceId: s.sourceId! })),
      ],
      proposedByAgentRunId: ctx.runId,
      proposedByMembershipId: input.requestedByMembershipId,
      triggeringText: [],
      sourceKey: ctx.sourceKey(0),
      email: {
        contactId: contact.id,
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
