import type { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { ForbiddenError, requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import {
  AccountNotFoundError,
  canEditAccount,
  getAccount,
  requireEditableAccount,
  type Actor,
} from "@/modules/accounts/service";
import { createTaskInput } from "./schemas";

/** Tasks (spec §6F3): manual create/assign/complete in M2; agents and plays create them later. */
export class TaskNotFoundError extends Error {
  constructor() {
    super("Task not found");
    this.name = "TaskNotFoundError";
  }
}

export async function createTask(actor: Actor, raw: z.input<typeof createTaskInput>) {
  const input = createTaskInput.parse(raw);
  if (input.accountId) await requireEditableAccount(actor, input.accountId);
  else requirePermission(actor, "accounts:edit");
  const db = scopedDb(actor);
  const owner = await db.membership.findFirst({
    where: { id: input.ownerMembershipId, status: "ACTIVE" },
  });
  if (!owner) throw new TaskNotFoundError();
  return db.$tenantTransaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: input.accountId ?? null,
        title: input.title,
        detail: input.detail ?? null,
        ownerMembershipId: owner.id,
        createdByMembershipId: actor.membershipId,
        dueAt: input.dueAt ?? null,
        priority: input.priority,
        origin: "HUMAN",
      },
    });
    if (owner.id !== actor.membershipId) {
      await tx.notification.create({
        data: {
          workspaceId: actor.workspaceId,
          recipientMembershipId: owner.id,
          type: "TASK_ASSIGNED",
          title: `New task: ${input.title}`,
          refType: "Task",
          refId: task.id,
          accountId: input.accountId ?? null,
        },
      });
    }
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "task.created",
        targetType: "Task",
        targetId: task.id,
        summary: `Created a task: ${input.title}`,
        after: {
          ownerMembershipId: owner.id,
          dueAt: input.dueAt ?? null,
          accountId: input.accountId ?? null,
        },
      },
      tx,
    );
    return task;
  });
}

/** The owner, or anyone who can edit the task's account, may complete it. */
export async function completeTask(actor: Actor, taskId: string) {
  const db = scopedDb(actor);
  const task = await db.task.findUnique({
    where: { id: taskId },
    include: { account: { select: { ownerMembershipId: true } } },
  });
  if (!task) throw new TaskNotFoundError();
  const allowed =
    task.ownerMembershipId === actor.membershipId ||
    (task.account
      ? canEditAccount(actor, task.account.ownerMembershipId)
      : actor.role === "ADMIN" || actor.role === "CS_LEADER");
  if (!allowed) throw new ForbiddenError("accounts:edit");
  if (task.status !== "OPEN") return task;
  return db.$tenantTransaction(async (tx) => {
    const done = await tx.task.update({
      where: { id: task.id },
      data: { status: "DONE", completedAt: new Date() },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "task.completed",
        targetType: "Task",
        targetId: task.id,
        summary: `Completed: ${task.title}`,
      },
      tx,
    );
    return done;
  });
}

const TASK_INCLUDE = {
  account: { select: { id: true, name: true } },
  owner: { select: { user: { select: { name: true, email: true } } } },
} as const;

/** "My tasks": open first, overdue and soonest due first, undated last. */
export async function listMyTasks(actor: Actor, status: "OPEN" | "DONE" = "OPEN") {
  return scopedDb(actor).task.findMany({
    where: { ownerMembershipId: actor.membershipId, status },
    orderBy:
      status === "OPEN"
        ? [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }]
        : [{ completedAt: "desc" }],
    take: 100,
    include: TASK_INCLUDE,
  });
}

export async function listAccountTasks(actor: Actor, accountId: string) {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  return scopedDb(actor).task.findMany({
    where: { accountId },
    orderBy: [{ status: "asc" }, { dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: 100,
    include: TASK_INCLUDE,
  });
}
