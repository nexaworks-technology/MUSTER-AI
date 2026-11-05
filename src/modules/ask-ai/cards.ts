import {
  approve,
  canDecideApproval,
  changeList,
  getApproval,
  reject,
  type ChangeResult,
} from "@/modules/approvals/service";
import type { AskActor } from "./tools";

/**
 * The Ask confirmation card is a view onto the Approval, nothing more (D-160, founder condition).
 * It is loaded through the approvals service AS THE VIEWER, so what they may see is what /approvals
 * lets them see; decide controls exist only when `canDecideApproval` (the check the Approvals
 * screen uses) passes; and Yes / No call `approvals.approve()` / `reject()` — the same authority
 * and the same guards at execution as a decision in /approvals. There is no other path.
 */
export interface AskApprovalCard {
  id: string;
  visible: boolean;
  kind?: string;
  reason?: string;
  status?: string;
  accountName?: string | null;
  changes?: string[];
  results?: ChangeResult[];
  email?: { to: string; subject: string; body: string; status: string } | null;
  decidedBy?: string | null;
  canDecide?: boolean;
}

export async function loadApprovalCard(
  viewer: AskActor,
  approvalId: string,
): Promise<AskApprovalCard> {
  let a;
  try {
    a = await getApproval(viewer, approvalId);
  } catch (e) {
    if (e instanceof Error && ["ApprovalNotFoundError", "ForbiddenError"].includes(e.name))
      return { id: approvalId, visible: false };
    throw e;
  }
  const payload = (a.payload ?? {}) as { changes?: unknown; changeResults?: ChangeResult[] };
  const parsed = changeList.safeParse(payload.changes);
  const message = a.outboundMessages[0] ?? null;
  const latest = a.revisions.at(-1) ?? null;
  return {
    id: a.id,
    visible: true,
    kind: a.kind,
    reason: a.reason,
    status: a.status,
    accountName: a.account?.name ?? null,
    changes: parsed.success ? parsed.data.items.map((i) => i.label) : undefined,
    results: Array.isArray(payload.changeResults) ? payload.changeResults : undefined,
    email:
      message && latest
        ? {
            to: message.toEmail,
            subject: latest.subject,
            body: latest.bodyText,
            status: message.status,
          }
        : null,
    decidedBy: a.decidedBy?.user.name ?? null,
    canDecide: canDecideApproval(viewer, a),
  };
}

/** Yes or No from the card: exactly approve() / reject(); their role checks and guards apply. */
export async function decideFromAsk(
  viewer: AskActor,
  input: { approvalId: string; decision: "yes" | "no" },
) {
  if (input.decision === "yes") return approve(viewer, { approvalId: input.approvalId });
  return reject(viewer, { approvalId: input.approvalId, note: "Declined from the Ask AI card" });
}
