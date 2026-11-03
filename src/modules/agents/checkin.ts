import { z } from "zod";
import { requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { isAiConfigured } from "@/lib/ai";
import { requireEditableAccount, type Actor } from "@/modules/accounts/service";
import { requestApproval } from "@/modules/approvals/service";
import { checkInSource, outreach, outreachOutput } from "./definitions/outreach";
import { runAgent, type ExecutorDeps } from "./executor";

/**
 * "Draft check-in" (M4 §2): a CSM asks for one check-in email about a signal or a ticket. With AI
 * configured the Outreach Agent drafts it; otherwise (or by choice) the CSM writes it. Either way
 * the result is an OutboundMessage DRAFT + a PENDING Approval: nothing is sent from here.
 */
export class CheckInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckInError";
  }
}

export const draftCheckInInput = z.object({
  sourceType: z.enum(["Signal", "Ticket"]),
  sourceId: z.string().min(1),
  contactId: z.string().min(1, "Choose who the email is to"),
  nonce: z.string().min(8),
  mode: z.enum(["ai", "human"]),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().max(10_000).optional(),
});

export type CheckInResult =
  | { status: "DRAFTED"; approvalId: string; by: "ai" | "human" }
  | { status: "NOT_CONFIGURED" }
  | { status: "NO_DRAFT"; runId: string; missing: string[] }
  | { status: "RUN_FAILED"; runId: string; runStatus: string };

/** What the draft screen needs: the record, its account and the contacts who can receive email. */
export async function checkInTarget(
  actor: Actor,
  sourceType: "Signal" | "Ticket",
  sourceId: string,
) {
  const db = scopedDb(actor);
  const src = await checkInSource(db, { sourceType, sourceId });
  if (!src) throw new CheckInError("That signal or ticket was not found.");
  const account = await requireEditableAccount(actor, src.accountId);
  const contacts = await db.contact.findMany({
    where: { accountId: src.accountId, email: { not: null }, status: "ACTIVE" },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true, title: true },
  });
  return {
    ...src,
    account: { id: account.id, name: account.name },
    contacts,
    aiConfigured: isAiConfigured(),
  };
}

export async function draftCheckIn(
  actor: Actor,
  raw: unknown,
  deps: ExecutorDeps = {},
): Promise<CheckInResult> {
  const input = draftCheckInInput.parse(raw);
  requirePermission(actor, "accounts:edit");
  const target = await checkInTarget(actor, input.sourceType, input.sourceId);
  if (!target.contacts.some((c) => c.id === input.contactId))
    throw new CheckInError("That contact is not on this account or has no email address.");

  if (input.mode === "human") {
    if (!input.subject || !input.body) throw new CheckInError("Write a subject and a message.");
    const approval = await requestApproval(actor, {
      accountId: target.accountId,
      kind: "SEND_EMAIL",
      reason: `Check-in about: ${target.label}`,
      proof: [{ sourceType: target.record.sourceType, sourceId: target.record.sourceId }],
      signalId: input.sourceType === "Signal" ? input.sourceId : undefined,
      proposedByMembershipId: actor.membershipId,
      triggeringText: target.messages.map((m) => m.bodyText),
      sourceKey: `checkin:${actor.membershipId}:${input.nonce}`,
      email: {
        contactId: input.contactId,
        subject: input.subject,
        body: input.body,
        origin: "HUMAN",
      },
    });
    return { status: "DRAFTED", approvalId: approval.id, by: "human" };
  }

  if (!deps.provider && !isAiConfigured()) return { status: "NOT_CONFIGURED" };
  const out = await runAgent(
    actor,
    outreach,
    {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      contactId: input.contactId,
      requestedByMembershipId: actor.membershipId,
      nonce: input.nonce,
    },
    { type: "check-in", id: `${input.sourceType}:${input.sourceId}:${input.nonce}` },
    deps,
  );
  if (out.kind === "not_configured") return { status: "NOT_CONFIGURED" };
  if (out.status !== "SUCCEEDED")
    return { status: "RUN_FAILED", runId: out.runId, runStatus: out.status };
  const db = scopedDb(actor);
  const approval = await db.approval.findFirst({ where: { proposedByAgentRunId: out.runId } });
  if (approval) return { status: "DRAFTED", approvalId: approval.id, by: "ai" };
  const run = await db.agentRun.findUniqueOrThrow({ where: { id: out.runId } });
  const parsed = outreachOutput.safeParse(run.output);
  return {
    status: "NO_DRAFT",
    runId: out.runId,
    missing: parsed.success ? (parsed.data.insufficientData?.missing ?? []) : [],
  };
}
