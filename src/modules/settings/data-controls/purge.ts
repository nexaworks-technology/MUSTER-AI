import { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { businessClock, type Clock } from "@/lib/dates";
import { rawDb } from "@/lib/db/raw";
import { TENANT_MODELS } from "@/lib/db/tenantModels";
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

export class DeletionError extends Error {
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
  const ws = await rawDb.workspace.findUniqueOrThrow({ where: { id: actor.workspaceId } });
  if (input.confirmName.trim() !== ws.name)
    throw new DeletionError("Type the workspace name exactly to confirm.");
  const now = clock();
  const graceEndsAt = new Date(+now + DELETION_GRACE_DAYS * DAY);
  await rawDb.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: ws.id }, data: { deletionRequestedAt: now } });
    await tx.workspaceTombstone.upsert({
      where: { workspaceId: ws.id },
      create: {
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        requestedAt: now,
        requestedByUserId: actor.userId,
        graceEndsAt,
      },
      update: {
        requestedAt: now,
        requestedByUserId: actor.userId,
        graceEndsAt,
        cancelledAt: null,
        purgedAt: null,
      },
    });
  });
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
  await rawDb.$transaction(async (tx) => {
    await tx.workspace.update({
      where: { id: actor.workspaceId },
      data: { deletionRequestedAt: null },
    });
    await tx.workspaceTombstone.updateMany({
      where: { workspaceId: actor.workspaceId, purgedAt: null },
      data: { cancelledAt: now },
    });
  });
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
  const t = await rawDb.workspaceTombstone.findUnique({
    where: { workspaceId: actor.workspaceId },
  });
  return t && !t.cancelledAt && !t.purgedAt
    ? { requestedAt: t.requestedAt, purgeAfter: t.graceEndsAt }
    : null;
}

async function countRows(workspaceId: string): Promise<Record<string, number>> {
  const sql = TENANT_MODELS.map(
    (m) => `SELECT '${m}' AS m, count(*)::int AS n FROM "${m}" WHERE "workspaceId" = $1`,
  ).join(" UNION ALL ");
  const rows = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx.$queryRawUnsafe<Array<{ m: string; n: number }>>(sql, workspaceId);
  });
  return Object.fromEntries(rows.filter((r) => Number(r.n) > 0).map((r) => [r.m, Number(r.n)]));
}

/** The purge job (`maintenance.purgeWorkspaces`): every workspace whose grace has ended. */
export async function purgeDueWorkspaces(
  clock: Clock = businessClock,
): Promise<{ purged: string[] }> {
  const now = clock();
  const due = await rawDb.workspaceTombstone.findMany({
    where: { cancelledAt: null, purgedAt: null, graceEndsAt: { lte: now } },
  });
  const purged: string[] = [];
  for (const t of due) {
    const ctx = { workspaceId: t.workspaceId };
    const counts = await countRows(t.workspaceId);
    // Objects first: if this fails, the rows stay and the next run retries.
    const objects = await getStorage().deleteWorkspacePrefix(ctx);
    await rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${t.workspaceId}, true)`;
      // AuditLog does not cascade from Workspace (it protects the log); the append-only trigger
      // lets these rows go only because this workspace's grace has ended.
      await tx.auditLog.deleteMany({ where: { workspaceId: t.workspaceId } });
      await tx.workspace.deleteMany({ where: { id: t.workspaceId } });
      await tx.workspaceTombstone.update({
        where: { id: t.id },
        data: { purgedAt: now, purgeCounts: { rows: counts, objects } as Prisma.InputJsonValue },
      });
    });
    logger.info({ workspaceId: t.workspaceId, objects }, "workspace purged");
    purged.push(t.workspaceId);
  }
  return { purged };
}
