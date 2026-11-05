import { z } from "zod";
import { changeItem, requestApproval } from "@/modules/approvals/service";
import { proposeChanges, runAskTool, type AskActor } from "@/modules/ask-ai/service";
import { defineAgent, type ActResult } from "../define";
import { baseAgentOutput, type ContextBundle } from "../schemas";

/**
 * Ask AI (M11 S10, spec §6M, ARCHITECTURE §6.2 row 14; tier deep). Answers ONLY from the records
 * its scoped tools returned to the asking user (M11 rule 1). The retrieval steps were chosen by
 * the code-driven loop (D-159) and are this run's input (tool + input + record refs); the bundle is
 * rebuilt here by re-running exactly those tools AS THE ASKER, so the run's evidence is what that
 * user may see now. Validation is the shared evaluator: ≥ 1 citation to a retrieved record; every
 * number in the answer (dates included, D-164) and in any outreach draft must appear in a cited
 * record; figures must point at cited records. Changes are only PROPOSED (D-160/D-171): `act`
 * turns a proposal into an Approval (and an outreach draft into a SEND_EMAIL approval through the
 * dispatch guards), never into a change.
 */
export const askAiInput = z.object({
  question: z.string().trim().min(1).max(2000),
  /** The asker; the run re-resolves role, book scope and money permission from it. */
  membershipId: z.string().min(1),
  threadId: z.string().min(1),
  messageId: z.string().min(1),
  /** Earlier turns in the thread, newest last (text only, for context). */
  history: z
    .array(z.object({ role: z.enum(["USER", "ASSISTANT"]), text: z.string() }))
    .max(20)
    .default([]),
  retrieval: z
    .array(z.object({ tool: z.string().min(1), input: z.record(z.string(), z.unknown()) }))
    .max(24),
});
export type AskAiInput = z.infer<typeof askAiInput>;

const figure = z.object({
  value: z.string().min(1).max(64),
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
  field: z.string().min(1).max(64),
});
export const askAiOutput = z.object({
  ...baseAgentOutput.shape,
  answer: z.string().min(1).max(4000),
  figures: z.array(figure).max(50).default([]),
  proposal: z
    .object({
      reason: z.string().trim().min(1).max(500),
      items: z.array(z.lazy(() => changeItem)).min(1).max(200),
    })
    .optional(),
  outreach: z
    .object({
      accountId: z.string().min(1),
      contactId: z.string().min(1),
      subject: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(5000),
    })
    .optional(),
});
export type AskAiOutput = z.infer<typeof askAiOutput>;

/** The asker as a service Actor, from the membership the run names (scoped to the workspace). */
export async function askerFor(
  db: {
    membership: {
      findUniqueOrThrow: (a: {
        where: { id: string };
      }) => Promise<{
        id: string;
        userId: string;
        role: string;
        canViewRevenue: boolean;
        bookScope: string;
        status: string;
      }>;
    };
  },
  workspaceId: string,
  membershipId: string,
): Promise<AskActor> {
  const m = await db.membership.findUniqueOrThrow({ where: { id: membershipId } });
  if (m.status !== "ACTIVE") throw new Error("The asker is no longer an active member");
  return {
    workspaceId,
    userId: m.userId,
    membershipId: m.id,
    role: m.role as AskActor["role"],
    canViewRevenue: m.canViewRevenue,
    bookScope: m.bookScope as AskActor["bookScope"],
  };
}

/** Records the run retrieved, as the evaluator's bundle, plus every "not found" the tools said. */
export async function retrieve(actor: AskActor, steps: AskAiInput["retrieval"]) {
  const bundle: ContextBundle = [];
  const seen = new Set<string>();
  const notFound: string[] = [];
  for (const step of steps) {
    let out;
    try {
      out = await runAskTool(actor, step.tool, step.input);
    } catch {
      notFound.push(`The tool ${step.tool} could not run with that input.`);
      continue;
    }
    if (out.notFound) notFound.push(out.notFound);
    for (const r of out.records) {
      if (seen.has(r.ref)) continue;
      seen.add(r.ref);
      bundle.push({ sourceType: r.type, sourceId: r.id, fields: { label: r.label, ...r.fields } });
    }
  }
  return { bundle, notFound: [...new Set(notFound)] };
}

const has = (bundle: ContextBundle, type: string, id: string) =>
  bundle.some((r) => r.sourceType === type && r.sourceId === id);
const mentionsAccount = (bundle: ContextBundle, accountId: string) =>
  bundle.some(
    (r) =>
      (r.sourceType === "Account" && r.sourceId === accountId) || r.fields.accountId === accountId,
  );

export const askAi = defineAgent<AskAiInput, AskAiOutput>({
  key: "ask-ai",
  version: "1.0.0",
  description:
    "Answers questions from the asker's scoped records, with citations; proposes changes for approval.",
  modelTier: "deep",
  tierReason: "Multi-record reasoning across accounts, calls and contracts in one answer.",
  prompt: { name: "ask-ai", version: "1.0.0" },
  inputSchema: askAiInput,
  outputSchema: askAiOutput,
  async buildContext(db, input, ctx) {
    const actor = await askerFor(db, ctx.workspaceId, input.membershipId);
    const { bundle, notFound } = await retrieve(actor, input.retrieval);
    return {
      bundle,
      vars: {
        question: input.question,
        history:
          input.history.map((h) => `${h.role === "USER" ? "User" : "You"}: ${h.text}`).join("\n") ||
          "(none)",
        notFound: notFound.join("\n") || "(none)",
      },
    };
  },
  extraCitations: (o) => o.figures.map((f) => ({ sourceType: f.sourceType, sourceId: f.sourceId })),
  narrative: (o) => [
    o.answer,
    ...o.figures.map((f) => f.value),
    ...(o.outreach ? [o.outreach.subject, o.outreach.body] : []),
    ...(o.proposal ? [o.proposal.reason] : []),
  ],
  forbiddenNumericFields: ["confidence", "amountMinor"],
  approvalPolicy: "INTERNAL",
  async act(output, ctx): Promise<ActResult> {
    const input = askAiInput.parse(ctx.input);
    const effects: ActResult["effects"] = [];
    const proof = output.citations.map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId }));
    const actor = await askerFor(ctx.db, ctx.workspaceId, input.membershipId);
    if (output.proposal) {
      // Every id the proposal names must be one the run retrieved (no invented ids).
      const items = output.proposal.items.filter(
        (i) =>
          mentionsAccount(ctx.bundle, i.accountId) &&
          (i.kind !== "ENROLL_PLAY" || has(ctx.bundle, "Play", i.playId)),
      );
      if (items.length) {
        const res = await proposeChanges(actor, {
          reason: output.proposal.reason,
          items,
          proof,
          sourceKey: ctx.sourceKey(0),
          proposedByAgentRunId: ctx.runId,
        });
        if (res.approvalId) effects.push({ type: "Approval", id: res.approvalId });
      }
    }
    if (
      output.outreach &&
      has(ctx.bundle, "Contact", output.outreach.contactId) &&
      mentionsAccount(ctx.bundle, output.outreach.accountId)
    ) {
      const approval = await requestApproval(actor, {
        accountId: output.outreach.accountId,
        kind: "SEND_EMAIL",
        reason: `Outreach drafted by Ask AI: ${output.outreach.subject}`,
        proof,
        proposedByAgentRunId: ctx.runId,
        proposedByMembershipId: actor.membershipId,
        triggeringText: [input.question],
        sourceKey: ctx.sourceKey(1),
        email: {
          contactId: output.outreach.contactId,
          subject: output.outreach.subject,
          body: output.outreach.body,
          origin: "AI",
          agentRunId: ctx.runId,
        },
      });
      effects.push({ type: "Approval", id: approval.id });
    }
    return { effects, actionTaken: effects.length ? "APPROVAL_REQUESTED" : "NONE" };
  },
});
