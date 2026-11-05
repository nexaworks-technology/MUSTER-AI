import type { ApprovalKind } from "@prisma/client";
import { z } from "zod";
import { scopedDb } from "@/lib/db/scoped";
import { canEditAccount, getAccount } from "@/modules/accounts/service";
import { changeItem, requestApproval, type LabelledChange } from "@/modules/approvals/service";
import type { AskActor } from "./tools";

/**
 * M11 S9 (rule 1, D-160): Ask AI PROPOSES record changes; it never applies one. A proposal becomes
 * one real Approval carrying the exact change list (each item with a plain label), routed to the
 * account owner like every other approval. Items the asker cannot act on are not proposed: they
 * come back as `skipped` with a reason. Nothing changes until a human approves it through
 * `approvals.approve()` — from /approvals or the Ask card, with the same authority either way.
 */
export const proposeInput = z.object({
  reason: z.string().trim().min(1).max(500),
  // Lazy: approvals and ask-ai load each other through the agents module.
  items: z.array(z.lazy(() => changeItem)).min(1).max(200),
  proof: z
    .array(
      z.object({
        sourceType: z.string().min(1),
        sourceId: z.string().min(1),
        label: z.string().optional(),
      }),
    )
    .min(1),
  sourceKey: z.string().min(1).max(200),
  proposedByAgentRunId: z.string().min(1).optional(),
});
export type ProposeInput = z.input<typeof proposeInput>;
export interface ProposalResult {
  approvalId: string | null;
  proposed: LabelledChange[];
  skipped: Array<{ index: number; reason: string }>;
}

const WORDS: Record<string, string> = {
  HIGH_TOUCH: "High-touch",
  MID_TOUCH: "Mid-touch",
  LONG_TAIL: "Long-tail",
};

export async function proposeChanges(actor: AskActor, raw: ProposeInput): Promise<ProposalResult> {
  const input = proposeInput.parse(raw);
  const db = scopedDb(actor);
  const plays = new Map(
    (
      await db.play.findMany({
        where: {
          id: { in: input.items.flatMap((i) => (i.kind === "ENROLL_PLAY" ? [i.playId] : [])) },
        },
        select: { id: true, name: true, status: true },
      })
    ).map((p) => [p.id, p]),
  );
  const proposed: LabelledChange[] = [];
  const skipped: ProposalResult["skipped"] = [];
  for (const [index, item] of input.items.entries()) {
    const account = await getAccount(actor, item.accountId);
    if (!account) {
      skipped.push({ index, reason: "You cannot see that account." });
      continue;
    }
    if (!canEditAccount(actor, account.ownerMembershipId)) {
      skipped.push({ index, reason: `You cannot change ${account.name}.` });
      continue;
    }
    switch (item.kind) {
      case "ENROLL_PLAY": {
        const play = plays.get(item.playId);
        if (!play || play.status !== "PUBLISHED") {
          skipped.push({ index, reason: "That play is not published." });
          continue;
        }
        proposed.push({ ...item, label: `Enrol ${account.name} in the play "${play.name}"` });
        break;
      }
      case "UPDATE_FIELD": {
        const from =
          item.field === "tier"
            ? account.tier
            : item.field === "lifecycleStage"
              ? account.lifecycleStage
              : account.ownerName;
        const to = item.value === null ? "none" : (WORDS[item.value] ?? item.value);
        proposed.push({
          ...item,
          label: `Change ${item.field === "ownerMembershipId" ? "owner" : item.field === "lifecycleStage" ? "stage" : "tier"} of ${account.name}: ${WORDS[from ?? ""] ?? from ?? "none"} → ${to}`,
        });
        break;
      }
      case "CREATE_TASK":
        proposed.push({ ...item, label: `Create the task "${item.title}" on ${account.name}` });
        break;
    }
  }
  if (proposed.length === 0) return { approvalId: null, proposed, skipped };
  const kind: ApprovalKind = proposed.length === 1 ? proposed[0]!.kind : "BULK_ACTION";
  const approval = await requestApproval(actor, {
    accountId: proposed[0]!.accountId,
    kind,
    reason: input.reason,
    proof: input.proof,
    proposedByMembershipId: actor.membershipId,
    ...(input.proposedByAgentRunId ? { proposedByAgentRunId: input.proposedByAgentRunId } : {}),
    sourceKey: input.sourceKey,
    changes: { items: proposed },
  });
  return { approvalId: approval.id, proposed, skipped };
}
