import { z } from "zod";
import { requirePermission } from "@/lib/auth/permissions";
import { isAiConfigured } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { requireEditableAccount, type Actor } from "@/modules/accounts/service";
import { expansionFinder } from "./definitions/expansion-finder";
import { runAgent, type ExecutorDeps } from "./executor";

/**
 * "Ask the Expansion Finder" (M7): a CSM asks for the note and the conversation draft for one
 * opportunity, any time. The draft lands in Approvals; nothing is sent from here. Without AI
 * configured it says so instead of faking output.
 */
export const expansionAskInput = z.object({
  opportunityId: z.string().min(1),
  nonce: z.string().min(8),
});

export type ExpansionAskResult =
  | { status: "DRAFTED"; runId: string; approvalId: string | null }
  | { status: "NOT_CONFIGURED" }
  | { status: "NO_SIGN"; runId: string; missing: string[] }
  | { status: "RUN_FAILED"; runId: string; runStatus: string };

export async function askExpansionFinder(
  actor: Actor,
  raw: unknown,
  deps: ExecutorDeps = {},
): Promise<ExpansionAskResult> {
  const input = expansionAskInput.parse(raw);
  requirePermission(actor, "accounts:edit");
  const db = scopedDb(actor);
  const opp = await db.expansionOpportunity.findUnique({
    where: { id: input.opportunityId },
    select: { accountId: true },
  });
  if (!opp) throw new Error("This opportunity does not exist.");
  await requireEditableAccount(actor, opp.accountId);
  if (!deps.provider && !isAiConfigured()) return { status: "NOT_CONFIGURED" };
  const out = await runAgent(
    actor,
    expansionFinder,
    { opportunityId: input.opportunityId },
    { type: "ask", id: `${input.opportunityId}:${input.nonce}` },
    deps,
  );
  if (out.kind === "not_configured") return { status: "NOT_CONFIGURED" };
  if (out.status !== "SUCCEEDED")
    return { status: "RUN_FAILED", runId: out.runId, runStatus: out.status };
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: out.runId } });
  const o = run.output as {
    narrative?: string | null;
    insufficientData?: { missing?: string[] };
  } | null;
  if (!o?.narrative)
    return { status: "NO_SIGN", runId: out.runId, missing: o?.insufficientData?.missing ?? [] };
  const approval = await db.approval.findFirst({ where: { proposedByAgentRunId: out.runId } });
  return { status: "DRAFTED", runId: out.runId, approvalId: approval?.id ?? null };
}
