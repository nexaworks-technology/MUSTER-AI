import type { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { businessClock, type Clock } from "@/lib/dates";
import {
  countWorkspaceRows,
  deleteWorkspaceRows,
  dueTombstones,
  findTombstone,
  findWorkspace,
  markDeletionCancelled,
  markDeletionRequested,
} from "@/lib/db/deletion";
import { logger } from "@/lib/logger";
import { getStorage } from "@/lib/storage";
import type { Actor } from "@/modules/accounts/service";

/**
 * M12 B2 — workspace deletion (§6N7, Q-10, D-179). An Admin's typed confirmation requests it and
 * starts a DELETION_GRACE_DAYS grace period (cancellable). After it, the purge job deletes the
 * workspace's object prefix and then the Workspace row, whose cascade removes every [W] row; the
 * AuditLog append-only trigger permits those deletes only for a workspace whose uncancelled
 * tombstone's grace has ended (checked against the database clock, which code cannot fake). A
 * non-tenant WorkspaceTombstone records the request and the purge.
 */
export const DELETION_GRACE_DAYS = 7;
const DAY = 86_400_000;

/** A refusal the person can act on (wrong confirmation); shown as-is on the form. */
export class DeletionError extends Error {
  readonly userFacing = true;
  constructor(message: string) {
    super(message);
    this.name = "DeletionError";
  }
}

export async function requestDeletion(
  actor: Actor,
  input: { confirmName: string },
  clock: Clock = businessClock,
): Promise<{ purgeAfter: Date }> {
  requirePermission(actor, "data:exportDelete");
  const ws = await findWorkspace(actor.workspaceId);
  if (input.confirmName.trim() !== ws.name)
    throw new DeletionError("Type the workspace name exactly to confirm.");
  const now = clock();
  const graceEndsAt = new Date(+now + DELETION_GRACE_DAYS * DAY);
  await markDeletionRequested(ws, actor.userId, now, graceEndsAt);
  await writeAudit({
    workspaceId: ws.id,
    actorType: "USER",
    actorId: actor.userId,
    action: "data.deletion_requested",
    targetType: "Workspace",
    targetId: ws.id,
    summary: `Workspace deletion requested; purge after ${graceEndsAt.toISOString().slice(0, 10)} unless cancelled`,
  });
  return { purgeAfter: graceEndsAt };
}

export async function cancelDeletion(actor: Actor, clock: Clock = businessClock): Promise<void> {
  requirePermission(actor, "data:exportDelete");
  const now = clock();
  await markDeletionCancelled(actor.workspaceId, now);
  await writeAudit({
    workspaceId: actor.workspaceId,
    actorType: "USER",
    actorId: actor.userId,
    action: "data.deletion_cancelled",
    targetType: "Workspace",
    targetId: actor.workspaceId,
    summary: "Workspace deletion cancelled during the grace period",
  });
}

/** The pending deletion of a workspace, for the Data controls page. */
export async function deletionStatus(actor: Actor) {
  requirePermission(actor, "data:exportDelete");
  const t = await findTombstone(actor.workspaceId);
  return t && !t.cancelledAt && !t.purgedAt
    ? { requestedAt: t.requestedAt, purgeAfter: t.graceEndsAt }
    : null;
}

/** The purge job (`maintenance.purgeWorkspaces`): every workspace whose grace has ended. */
export async function purgeDueWorkspaces(
  clock: Clock = businessClock,
): Promise<{ purged: string[] }> {
  const now = clock();
  const due = await dueTombstones(now);
  const purged: string[] = [];
  for (const t of due) {
    const ctx = { workspaceId: t.workspaceId };
    const counts = await countWorkspaceRows(t.workspaceId);
    // Objects first: if this fails, the rows stay and the next run retries.
    const objects = await getStorage().deleteWorkspacePrefix(ctx);
    await deleteWorkspaceRows(t.id, t.workspaceId, now, {
      rows: counts,
      objects,
    } as Prisma.InputJsonValue);
    logger.info({ workspaceId: t.workspaceId, objects }, "workspace purged");
    purged.push(t.workspaceId);
  }
  return { purged };
}
