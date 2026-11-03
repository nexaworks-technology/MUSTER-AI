import type { Approval, ApprovalKind, Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { writeOutboxEvent } from "@/lib/jobs/outbox";
import { can, ForbiddenError, requirePermission } from "@/lib/auth/permissions";
import { businessClock, type Clock } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { bookWhere, type Actor } from "@/modules/accounts/service";
import {
  detectSensitive,
  dispatch,
  type DispatchDeps,
  type DispatchResult,
} from "@/modules/outbound/service";
import { markActed } from "@/modules/outcomes/service";
import { getSettingsData } from "@/modules/settings/service";
import { resolveLevel } from "./level-resolver";

/**
 * Approvals: the only door out (spec §6F2, §6N1; CLAUDE.md Rule 3). Every proposal becomes a
 * PENDING Approval with its reason and proof; a person with approvals:decide on the account says
 * yes, edits then says yes, or says no. Editing writes a new DraftRevision (never an overwrite).
 * Sensitive approvals are never decided from Slack (Q-31) and never bulk-approved (D-76).
 */
export class ApprovalNotFoundError extends Error {
  constructor() {
    super("Approval not found");
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalStateError";
  }
}

export type DecisionChannel = "APP" | "SLACK";
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const proofItem = z.object({
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
  label: z.string().optional(),
});

export const requestApprovalInput = z.object({
  accountId: z.string().min(1),
  kind: z.enum([
    "SEND_EMAIL",
    "CREATE_TASK",
    "UPDATE_FIELD",
    "ENROLL_PLAY",
    "BULK_ACTION",
    "WRITE_BACK",
  ]),
  reason: z.string().trim().min(1).max(500),
  proof: z.array(proofItem).min(1, "An approval needs at least one source"),
  signalId: z.string().min(1).optional(),
  proposedByAgentRunId: z.string().min(1).optional(),
  proposedByMembershipId: z.string().min(1).optional(),
  /** Text that triggered the request (the ticket or email), checked for sensitive topics. */
  triggeringText: z.array(z.string()).default([]),
  stepTags: z.array(z.string()).default([]),
  sourceKey: z.string().min(1),
  /** WRITE_BACK only (M5): the change the integrations gate will push once approved. */
  writeBack: z
    .object({
      integrationId: z.string().min(1),
      field: z.string().min(1),
      accountId: z.string().min(1),
      value: z.string().min(1),
    })
    .optional(),
  email: z
    .object({
      contactId: z.string().min(1),
      subject: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(10_000),
      origin: z.enum(["HUMAN", "AI"]),
      agentRunId: z.string().min(1).optional(),
    })
    .optional(),
});
export type RequestApprovalInput = z.input<typeof requestApprovalInput>;

/**
 * Creates one approval (and, for an email, its draft and version 1). Idempotent by sourceKey: a
 * retried agent run or a double click returns the first approval. Slack (M5) calls this too.
 */
export async function requestApproval(ctx: TenantContext, raw: RequestApprovalInput) {
  const input = requestApprovalInput.parse(raw);
  const db = scopedDb(ctx);
  const existing = await db.approval.findUnique({
    where: { workspaceId_sourceKey: { workspaceId: ctx.workspaceId, sourceKey: input.sourceKey } },
  });
  if (existing) return existing;
  const account = await db.account.findUniqueOrThrow({
    where: { id: input.accountId },
    select: { id: true, tier: true, ownerMembershipId: true },
  });
  const extractions = await db.extraction.findMany({
    where: {
      accountId: account.id,
      kind: { in: ["CANCEL_LANGUAGE", "EXPORT_LANGUAGE", "COMPLAINT", "INTENT"] },
    },
    select: { kind: true, payload: true },
    take: 50,
    orderBy: { createdAt: "desc" },
  });
  const sensitive = detectSensitive({
    texts: [...input.triggeringText, input.email?.subject ?? "", input.email?.body ?? ""],
    extractions,
    stepTags: input.stepTags,
  });
  const settings = await getSettingsData(ctx.workspaceId);
  const requiredLevel = resolveLevel({
    tier: account.tier,
    customerFacing: input.kind === "SEND_EMAIL",
    workspaceCeiling: settings.approvals.workspaceCeiling,
    isSensitive: sensitive.isSensitive,
    autoSendEnabled: settings.outbound.autoSendEnabled,
  });
  const assigneeId = account.ownerMembershipId ?? (await fallbackLeader(ctx));
  return db.$tenantTransaction(async (tx) => {
    const approval = await tx.approval.create({
      data: {
        workspaceId: ctx.workspaceId,
        accountId: account.id,
        kind: input.kind as ApprovalKind,
        payload: json({
          ...(input.email ? { subject: input.email.subject } : {}),
          ...(input.writeBack ? { writeBack: input.writeBack } : {}),
        }),
        reason: input.reason,
        proof: json(input.proof),
        signalId: input.signalId ?? null,
        proposedByAgentRunId: input.proposedByAgentRunId ?? null,
        proposedByMembershipId: input.proposedByMembershipId ?? null,
        requiredLevel,
        isSensitive: sensitive.isSensitive,
        sensitiveReasons: sensitive.reasons,
        assigneeId,
        sourceKey: input.sourceKey,
      },
    });
    if (input.email) {
      const contact = await tx.contact.findUniqueOrThrow({ where: { id: input.email.contactId } });
      if (contact.accountId !== account.id)
        throw new ApprovalStateError("That contact is not on this account.");
      if (!contact.email) throw new ApprovalStateError("That contact has no email address.");
      const message = await tx.outboundMessage.create({
        data: {
          workspaceId: ctx.workspaceId,
          accountId: account.id,
          contactId: contact.id,
          toEmail: contact.email.toLowerCase(),
          approvalId: approval.id,
          signalId: input.signalId ?? null,
          subject: input.email.subject,
          bodyText: input.email.body,
          status: "AWAITING_APPROVAL",
          sendMode: "APPROVED",
          origin: input.email.origin,
          agentRunId: input.email.agentRunId ?? null,
          sourceKey: input.sourceKey,
          createdByMembershipId: input.proposedByMembershipId ?? null,
        },
      });
      await tx.draftRevision.create({
        data: {
          workspaceId: ctx.workspaceId,
          approvalId: approval.id,
          outboundMessageId: message.id,
          version: 1,
          subject: input.email.subject,
          bodyText: input.email.body,
          editedById:
            input.email.origin === "HUMAN" ? (input.proposedByMembershipId ?? null) : null,
          origin: input.email.origin,
          agentRunId: input.email.agentRunId ?? null,
        },
      });
    }
    // M5: Slack delivers the request to the assignee (no-op without Slack; D-95).
    await writeOutboxEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: "approval.requested",
      payload: { approvalId: approval.id },
    });
    if (assigneeId)
      await tx.notification.create({
        data: {
          workspaceId: ctx.workspaceId,
          recipientMembershipId: assigneeId,
          type: "APPROVAL_ASSIGNED",
          title: `Approval waiting: ${input.reason}`.slice(0, 200),
          refType: "Approval",
          refId: approval.id,
          accountId: account.id,
        },
      });
    await writeAudit(
      {
        workspaceId: ctx.workspaceId,
        actorType: input.proposedByAgentRunId
          ? "AGENT"
          : input.proposedByMembershipId
            ? "USER"
            : "SYSTEM",
        actorId: input.proposedByMembershipId ?? null,
        agentRunId: input.proposedByAgentRunId ?? null,
        action: "approval.requested",
        targetType: "Approval",
        targetId: approval.id,
        summary: `Approval requested (${requiredLevel}${sensitive.isSensitive ? `, sensitive: ${sensitive.reasons.join(", ")}` : ""}): ${input.reason}`,
        after: {
          requiredLevel,
          isSensitive: sensitive.isSensitive,
          sensitiveReasons: sensitive.reasons,
        },
      },
      tx,
    );
    return approval;
  });
}

/** The account owner decides; with no owner, the first CS Leader (then Admin) does. */
async function fallbackLeader(ctx: TenantContext): Promise<string | null> {
  const db = scopedDb(ctx);
  for (const role of ["CS_LEADER", "ADMIN"] as const) {
    const m = await db.membership.findFirst({
      where: { role, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (m) return m.id;
  }
  return null;
}

/** Book scope for approvals: a CSM sees and decides only on accounts in their book. */
function approvalScope(actor: Actor): Prisma.ApprovalWhereInput {
  const grant = can(actor, "approvals:decide") ?? can(actor, "accounts:view");
  if (!grant) throw new ForbiddenError("approvals:decide");
  return grant.scope === "ALL" ? {} : { account: bookWhere(actor, grant.scope) };
}

export const approvalListQuery = z.object({
  status: z.enum(["PENDING", "DECIDED", "ALL"]).default("PENDING"),
  cursor: z.coerce.number().int().min(0).default(0),
});

const PAGE = 25;

export async function listApprovals(actor: Actor, raw: unknown = {}) {
  const q = approvalListQuery.parse(raw);
  const where: Prisma.ApprovalWhereInput = {
    ...approvalScope(actor),
    ...(q.status === "PENDING"
      ? { status: "PENDING" }
      : q.status === "DECIDED"
        ? { status: { not: "PENDING" } }
        : {}),
  };
  const db = scopedDb(actor);
  const [rows, total] = await Promise.all([
    db.approval.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: q.cursor,
      take: PAGE,
      include: {
        account: { select: { id: true, name: true, tier: true } },
        assignee: { include: { user: { select: { name: true, email: true } } } },
        outboundMessages: { select: { id: true, subject: true, toEmail: true, status: true } },
      },
    }),
    db.approval.count({ where }),
  ]);
  return { rows, total, cursor: q.cursor, next: q.cursor + PAGE < total ? q.cursor + PAGE : null };
}

/** One approval with its draft versions; another book or workspace is "not found" (404). */
export async function getApproval(actor: Actor, approvalId: string) {
  const row = await scopedDb(actor).approval.findFirst({
    where: { id: approvalId, ...approvalScope(actor) },
    include: {
      account: { select: { id: true, name: true, tier: true, ownerMembershipId: true } },
      assignee: { include: { user: { select: { name: true, email: true } } } },
      decidedBy: { include: { user: { select: { name: true, email: true } } } },
      outboundMessages: true,
      revisions: {
        orderBy: { version: "asc" },
        include: { editedBy: { include: { user: { select: { name: true } } } } },
      },
      proposedByRun: { select: { id: true, agentKey: true, status: true } },
    },
  });
  if (!row) throw new ApprovalNotFoundError();
  return row;
}

export const decisionInput = z.object({
  approvalId: z.string().min(1),
  note: z.string().trim().max(1_000).optional(),
});
export const editInput = decisionInput.extend({
  subject: z.string().trim().min(1, "The subject can't be empty").max(200),
  body: z.string().trim().min(1, "The message can't be empty").max(10_000),
});
export const rejectInput = decisionInput.extend({
  note: z.string().trim().min(3, "Say why it is rejected (3 characters or more)").max(1_000),
});

export interface DecideOptions {
  via?: DecisionChannel;
  clock?: Clock;
  dispatch?: DispatchDeps;
}

export interface DecisionResult {
  approval: Approval;
  send?: DispatchResult | { status: "NOT_SENT"; reasons: string[] };
  /** WRITE_BACK approvals (M5): what the write-back gate did once approved. */
  writeBack?: { status: "PUSHED" | "REFUSED" | "FAILED" | "ALREADY_PUSHED"; plain: string };
}

async function loadPending(actor: Actor, approvalId: string, via: DecisionChannel) {
  requirePermission(actor, "approvals:decide");
  const a = await getApproval(actor, approvalId);
  if (a.status !== "PENDING")
    throw new ApprovalStateError(
      `This approval was already ${a.status.toLowerCase().replaceAll("_", " ")}.`,
    );
  if (a.isSensitive && via === "SLACK")
    throw new ApprovalStateError("Sensitive items are decided in the app, never from Slack.");
  return a;
}

/** An approved WRITE_BACK goes through the integrations gate, which re-checks it (Rule 7). */
async function writeBackIfApproved(
  actor: Actor,
  a: Approval,
): Promise<DecisionResult["writeBack"]> {
  if (a.kind !== "WRITE_BACK") return undefined;
  // Loaded on use: integrations depends on approvals for requestApproval.
  const { executeApprovedWriteBack } = await import("@/modules/integrations/service");
  return executeApprovedWriteBack(actor, a.id);
}

async function sendIfEmail(
  actor: Actor,
  a: Approval,
  deps?: DispatchDeps,
): Promise<DecisionResult["send"]> {
  if (a.kind !== "SEND_EMAIL") return undefined;
  const message = await scopedDb(actor).outboundMessage.findFirst({ where: { approvalId: a.id } });
  if (!message) return undefined;
  try {
    return await dispatch(actor, message.id, deps);
  } catch (e) {
    if (e instanceof Error && e.name === "DispatchRefusedError")
      return { status: "NOT_SENT", reasons: (e as Error & { reasons: string[] }).reasons };
    throw e;
  }
}

export async function approve(
  actor: Actor,
  raw: unknown,
  opts: DecideOptions = {},
): Promise<DecisionResult> {
  const input = decisionInput.parse(raw);
  const via = opts.via ?? "APP";
  const a = await loadPending(actor, input.approvalId, via);
  const now = (opts.clock ?? businessClock)();
  const approval = await scopedDb(actor).$tenantTransaction(async (tx) => {
    const updated = await tx.approval.update({
      where: { id: a.id },
      data: {
        status: "APPROVED",
        decidedById: actor.membershipId,
        decidedAt: now,
        decidedVia: via,
        decisionNote: input.note ?? null,
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "approval.approved",
        targetType: "Approval",
        targetId: a.id,
        agentRunId: a.proposedByAgentRunId,
        summary: `Approved: ${a.reason}`,
        after: { via, note: input.note ?? null },
      },
      tx,
    );
    return updated;
  });
  if (approval.signalId)
    await markActed(
      actor,
      { signalId: approval.signalId },
      { type: "Approval", id: approval.id },
      opts.clock,
    );
  return {
    approval,
    send: await sendIfEmail(actor, approval, opts.dispatch),
    writeBack: await writeBackIfApproved(actor, approval),
  };
}

/** Edit then approve: the edit becomes version n+1; the earlier versions stay as they were. */
export async function editAndApprove(
  actor: Actor,
  raw: unknown,
  opts: DecideOptions = {},
): Promise<DecisionResult> {
  const input = editInput.parse(raw);
  const via = opts.via ?? "APP";
  const a = await loadPending(actor, input.approvalId, via);
  const message = a.outboundMessages[0];
  if (a.kind !== "SEND_EMAIL" || !message)
    throw new ApprovalStateError("Only an email draft can be edited.");
  const latest = a.revisions.at(-1)!;
  // The edited text is checked again: an edit can make a draft sensitive, never less so.
  const sensitive = detectSensitive({ texts: [input.subject, input.body] });
  if (sensitive.isSensitive && via === "SLACK")
    throw new ApprovalStateError("Sensitive items are decided in the app, never from Slack.");
  const now = (opts.clock ?? businessClock)();
  const approval = await scopedDb(actor).$tenantTransaction(async (tx) => {
    const version = latest.version + 1;
    await tx.draftRevision.create({
      data: {
        workspaceId: actor.workspaceId,
        approvalId: a.id,
        outboundMessageId: message.id,
        version,
        subject: input.subject,
        bodyText: input.body,
        editedById: actor.membershipId,
        origin: "HUMAN",
      },
    });
    await tx.outboundMessage.update({
      where: { id: message.id },
      data: { subject: input.subject, bodyText: input.body },
    });
    const reasons = [...new Set([...a.sensitiveReasons, ...sensitive.reasons])];
    const editDiff = {
      fromVersion: latest.version,
      toVersion: version,
      subjectChanged: latest.subject !== input.subject,
      bodyChanged: latest.bodyText !== input.body,
    };
    const updated = await tx.approval.update({
      where: { id: a.id },
      data: {
        status: "EDITED_APPROVED",
        editDiff,
        isSensitive: a.isSensitive || sensitive.isSensitive,
        sensitiveReasons: reasons,
        requiredLevel:
          a.isSensitive || sensitive.isSensitive ? "DRAFT_FOR_APPROVAL" : a.requiredLevel,
        decidedById: actor.membershipId,
        decidedAt: now,
        decidedVia: via,
        decisionNote: input.note ?? null,
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "approval.edited_approved",
        targetType: "Approval",
        targetId: a.id,
        agentRunId: a.proposedByAgentRunId,
        summary: `Edited (v${latest.version} → v${version}) and approved: ${a.reason}`,
        before: { version: latest.version },
        after: { ...editDiff, via },
      },
      tx,
    );
    return updated;
  });
  if (approval.signalId)
    await markActed(
      actor,
      { signalId: approval.signalId },
      { type: "Approval", id: approval.id },
      opts.clock,
    );
  return { approval, send: await sendIfEmail(actor, approval, opts.dispatch) };
}

export async function reject(
  actor: Actor,
  raw: unknown,
  opts: DecideOptions = {},
): Promise<DecisionResult> {
  const input = rejectInput.parse(raw);
  const via = opts.via ?? "APP";
  const a = await loadPending(actor, input.approvalId, via);
  const now = (opts.clock ?? businessClock)();
  const approval = await scopedDb(actor).$tenantTransaction(async (tx) => {
    const updated = await tx.approval.update({
      where: { id: a.id },
      data: {
        status: "REJECTED",
        decidedById: actor.membershipId,
        decidedAt: now,
        decidedVia: via,
        decisionNote: input.note,
      },
    });
    await tx.outboundMessage.updateMany({
      where: { approvalId: a.id, status: { not: "SENT" } },
      data: { status: "CANCELLED" },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "approval.rejected",
        targetType: "Approval",
        targetId: a.id,
        agentRunId: a.proposedByAgentRunId,
        summary: `Rejected: ${a.reason}`,
        after: { note: input.note, via },
      },
      tx,
    );
    return updated;
  });
  return { approval };
}

export const bulkInput = z.object({
  decision: z.enum(["approve", "reject"]),
  approvalIds: z.array(z.string().min(1)).min(1).max(50),
  /** The exact list the person confirmed; it must match the selection one for one. */
  confirmedIds: z.array(z.string().min(1)),
  note: z.string().trim().max(1_000).optional(),
});

/**
 * Bulk decide with an exact confirmation list (M4 §2). Sensitive items are never bulk-approved
 * (D-76): each needs its own look. Nothing is decided unless the whole selection can be.
 */
export async function bulkDecide(actor: Actor, raw: unknown, opts: DecideOptions = {}) {
  const input = bulkInput.parse(raw);
  const selected = [...new Set(input.approvalIds)].sort();
  const confirmed = [...new Set(input.confirmedIds)].sort();
  if (selected.length !== confirmed.length || selected.some((id, i) => id !== confirmed[i]))
    throw new ApprovalStateError(
      "The confirmed list does not match the selection. Nothing was decided.",
    );
  const rows = await Promise.all(selected.map((id) => loadPending(actor, id, opts.via ?? "APP")));
  if (input.decision === "approve") {
    const sensitive = rows.filter((r) => r.isSensitive);
    if (sensitive.length)
      throw new ApprovalStateError(
        `${sensitive.length} selected item(s) are sensitive and must be reviewed one at a time. Nothing was decided.`,
      );
  }
  if (input.decision === "reject" && (!input.note || input.note.length < 3))
    throw new ApprovalStateError("Say why they are rejected (3 characters or more).");
  const results: DecisionResult[] = [];
  for (const r of rows)
    results.push(
      input.decision === "approve"
        ? await approve(actor, { approvalId: r.id, note: input.note }, opts)
        : await reject(actor, { approvalId: r.id, note: input.note }, opts),
    );
  await writeAudit({
    workspaceId: actor.workspaceId,
    actorType: "USER",
    actorId: actor.userId,
    action: `approval.bulk_${input.decision}`,
    targetType: "Approval",
    summary: `Bulk ${input.decision === "approve" ? "approved" : "rejected"} ${rows.length} approval(s)`,
    after: { approvalIds: selected },
  });
  return results;
}
