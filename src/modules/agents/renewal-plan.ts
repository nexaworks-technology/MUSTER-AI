import { z } from "zod";
import { requirePermission } from "@/lib/auth/permissions";
import { isAiConfigured } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { requireEditableAccount, type Actor } from "@/modules/accounts/service";
import { renewalManager } from "./definitions/renewal-manager";
import { runAgent, type ExecutorDeps } from "./executor";

/**
 * "Ask the Renewal Manager" (M7): a CSM asks for the plan, talk track, outreach draft and next step
 * for one renewal, any time (the sweep covers the windows). The outreach lands in Approvals and
 * nothing is sent from here. Without AI configured it says so instead of faking output.
 */
export const renewalPlanInput = z.object({
  renewalId: z.string().min(1),
  nonce: z.string().min(8),
});

export type RenewalPlanResult =
  | { status: "DRAFTED"; runId: string; approvalId: string | null }
  | { status: "NOT_CONFIGURED" }
  | { status: "NO_PLAN"; runId: string; missing: string[] }
  | { status: "RUN_FAILED"; runId: string; runStatus: string };

export async function askRenewalManager(
  actor: Actor,
  raw: unknown,
  deps: ExecutorDeps = {},
): Promise<RenewalPlanResult> {
  const input = renewalPlanInput.parse(raw);
  requirePermission(actor, "accounts:edit");
  const db = scopedDb(actor);
  const renewal = await db.renewal.findUnique({
    where: { id: input.renewalId },
    select: { accountId: true },
  });
  if (!renewal) throw new Error("This renewal does not exist.");
  await requireEditableAccount(actor, renewal.accountId);
  if (!deps.provider && !isAiConfigured()) return { status: "NOT_CONFIGURED" };
  const out = await runAgent(
    actor,
    renewalManager,
    { renewalId: input.renewalId },
    { type: "brief", id: `${input.renewalId}:${input.nonce}` },
    deps,
  );
  if (out.kind === "not_configured") return { status: "NOT_CONFIGURED" };
  if (out.status !== "SUCCEEDED")
    return { status: "RUN_FAILED", runId: out.runId, runStatus: out.status };
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: out.runId } });
  const approval = await db.approval.findFirst({ where: { proposedByAgentRunId: out.runId } });
  const doc = await db.document.findFirst({ where: { agentRunId: out.runId } });
  if (!doc) {
    const o = run.output as { insufficientData?: { missing?: string[] } } | null;
    return { status: "NO_PLAN", runId: out.runId, missing: o?.insufficientData?.missing ?? [] };
  }
  return { status: "DRAFTED", runId: out.runId, approvalId: approval?.id ?? null };
}
