import type { Approval, Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";

/**
 * M11 S9 (D-160): the exact change list an Approval can carry — proposed by Ask AI, never applied
 * by it. Executed only when a human approves, through `approvals.approve()`, item by item through
 * each item's own module service called as the DECIDER (the same per-item permission checks as
 * that module's screen). An item that cannot run is skipped with a reason; one audit row per item.
 * Approvals without a change list (plays, agents) are untouched by this file.
 */
const id = z.string().min(1).max(64);
export const changeItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("CREATE_TASK"),
    accountId: id,
    title: z.string().trim().min(1).max(200),
    detail: z.string().trim().max(2000).optional(),
    ownerMembershipId: id.optional(),
    dueOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  }),
  z.object({
    kind: z.literal("UPDATE_FIELD"),
    accountId: id,
    field: z.enum(["tier", "lifecycleStage", "ownerMembershipId"]),
    value: z.string().min(1).max(64).nullable(),
  }),
  z.object({ kind: z.literal("ENROLL_PLAY"), accountId: id, playId: id }),
]);
export type ChangeItem = z.infer<typeof changeItem>;
export const labelledChange = z.intersection(
  changeItem,
  z.object({ label: z.string().min(1).max(300) }),
);
export type LabelledChange = z.infer<typeof labelledChange>;
export const changeList = z.object({ items: z.array(labelledChange).min(1).max(200) });

export interface ChangeResult {
  index: number;
  label: string;
  status: "EXECUTED" | "SKIPPED";
  reason?: string;
  ref?: { type: string; id: string };
}
export interface ChangesOutcome {
  executed: number;
  skipped: Array<{ index: number; label: string; reason: string }>;
  results: ChangeResult[];
}

/** Expected refusals become a plain-words skip reason; anything else is a bug and propagates. */
const REFUSALS: Record<string, (e: Error) => string> = {
  ForbiddenError: () => "You cannot change that account.",
  AccountNotFoundError: () => "You cannot see that account.",
  AccountInputError: (e) => e.message,
  TaskNotFoundError: () => "The task owner is not an active member.",
  ZodError: () => "The change is not valid.",
  PlayEnrolError: (e) => e.message,
};

async function runItem(actor: Actor, item: LabelledChange, approvalId: string) {
  switch (item.kind) {
    case "CREATE_TASK": {
      const { createTask } = await import("@/modules/tasks/service");
      const { getAccount } = await import("@/modules/accounts/service");
      const account = await getAccount(actor, item.accountId);
      const task = await createTask(actor, {
        accountId: item.accountId,
        title: item.title,
        detail: item.detail,
        ownerMembershipId:
          item.ownerMembershipId ?? account?.ownerMembershipId ?? actor.membershipId,
        dueAt: item.dueOn ? new Date(`${item.dueOn}T12:00:00Z`) : undefined,
      });
      return { type: "Task", id: task.id };
    }
    case "UPDATE_FIELD": {
      const { updateAccountFields } = await import("@/modules/accounts/service");
      await updateAccountFields(actor, item.accountId, { [item.field]: item.value });
      return { type: "Account", id: item.accountId };
    }
    case "ENROLL_PLAY": {
      // Loaded on use: plays depends on approvals.
      const { enrolAccountInPlay } = await import("@/modules/plays/service");
      const res = await enrolAccountInPlay(actor, {
        playId: item.playId,
        accountId: item.accountId,
        triggerRef: `approval:${approvalId}`,
      });
      return { type: "PlayRun", id: res.playRunId };
    }
  }
}

export async function executeApprovedChanges(
  actor: Actor,
  approval: Approval,
): Promise<ChangesOutcome | undefined> {
  const payload = (approval.payload ?? {}) as Record<string, unknown>;
  if (!payload.changes) return undefined;
  if (payload.changeResults) return undefined; // executed once, never again
  const { items } = changeList.parse(payload.changes);
  const results: ChangeResult[] = [];
  for (const [index, item] of items.entries()) {
    try {
      const ref = await runItem(actor, item, approval.id);
      results.push({ index, label: item.label, status: "EXECUTED", ref });
    } catch (e) {
      const plain = e instanceof Error ? REFUSALS[e.name] : undefined;
      if (!plain) throw e;
      results.push({ index, label: item.label, status: "SKIPPED", reason: plain(e as Error) });
    }
  }
  const db = scopedDb(actor);
  await db.$tenantTransaction(async (tx) => {
    await tx.approval.update({
      where: { id: approval.id },
      data: { payload: { ...payload, changeResults: results } as unknown as Prisma.InputJsonValue },
    });
    for (const r of results)
      await writeAudit(
        {
          workspaceId: actor.workspaceId,
          actorType: "USER",
          actorId: actor.userId,
          action: r.status === "EXECUTED" ? "approval.change_executed" : "approval.change_skipped",
          targetType: "Approval",
          targetId: approval.id,
          agentRunId: approval.proposedByAgentRunId,
          summary: r.status === "EXECUTED" ? r.label : `Skipped: ${r.label} — ${r.reason}`,
          after: { index: r.index, ref: r.ref ?? null, reason: r.reason ?? null },
        },
        tx,
      );
  });
  const skipped = results
    .filter((r) => r.status === "SKIPPED")
    .map((r) => ({ index: r.index, label: r.label, reason: r.reason ?? "" }));
  return { executed: results.length - skipped.length, skipped, results };
}
