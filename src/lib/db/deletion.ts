import type { Prisma, Workspace, WorkspaceTombstone } from "@prisma/client";
import { rawDb } from "./raw";
import { TENANT_MODELS } from "./tenantModels";

/**
 * Workspace deletion's database side (M12 B2, D-179). Lives in src/lib/db because it works on
 * global models (Workspace, WorkspaceTombstone) and counts rows across every [W] table. The
 * AuditLog trigger, not this code, decides whether audit rows may be deleted.
 */
export function findWorkspace(workspaceId: string): Promise<Workspace> {
  return rawDb.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
}

export async function markDeletionRequested(
  ws: Pick<Workspace, "id" | "slug">,
  requestedByUserId: string,
  requestedAt: Date,
  graceEndsAt: Date,
): Promise<void> {
  await rawDb.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: ws.id }, data: { deletionRequestedAt: requestedAt } });
    await tx.workspaceTombstone.upsert({
      where: { workspaceId: ws.id },
      create: {
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        requestedAt,
        requestedByUserId,
        graceEndsAt,
      },
      update: { requestedAt, requestedByUserId, graceEndsAt, cancelledAt: null, purgedAt: null },
    });
  });
}

export async function markDeletionCancelled(workspaceId: string, at: Date): Promise<void> {
  await rawDb.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: workspaceId }, data: { deletionRequestedAt: null } });
    await tx.workspaceTombstone.updateMany({
      where: { workspaceId, purgedAt: null },
      data: { cancelledAt: at },
    });
  });
}

export function findTombstone(workspaceId: string): Promise<WorkspaceTombstone | null> {
  return rawDb.workspaceTombstone.findUnique({ where: { workspaceId } });
}

export function dueTombstones(now: Date): Promise<WorkspaceTombstone[]> {
  return rawDb.workspaceTombstone.findMany({
    where: { cancelledAt: null, purgedAt: null, graceEndsAt: { lte: now } },
  });
}

/**
 * DEMO / E2E ONLY (M12 demo step 7; scripts/demo-purge-now.ts refuses outside test seams): ends the
 * grace period of an existing, uncancelled deletion request now, as if the days had passed. Only a
 * request the Admin already made can be fast-forwarded; it never creates one. Returns false when
 * there is none.
 */
export async function endGraceNowForDemo(workspaceId: string, now: Date): Promise<boolean> {
  const r = await rawDb.workspaceTombstone.updateMany({
    where: { workspaceId, cancelledAt: null, purgedAt: null },
    data: { graceEndsAt: new Date(+now - 60_000) },
  });
  return r.count === 1;
}

/** Rows per [W] model for one workspace (non-zero only). */
export async function countWorkspaceRows(workspaceId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    for (const model of TENANT_MODELS) {
      const delegate = (
        tx as unknown as Record<string, { count: (a: unknown) => Promise<number> }>
      )[model.charAt(0).toLowerCase() + model.slice(1)]!;
      const n = await delegate.count({ where: { workspaceId } });
      if (n > 0) counts[model] = n;
    }
  });
  return counts;
}

/** Deletes the workspace's AuditLog rows and the Workspace row (cascading every [W] row). */
export async function deleteWorkspaceRows(
  tombstoneId: string,
  workspaceId: string,
  purgedAt: Date,
  purgeCounts: Prisma.InputJsonValue,
): Promise<void> {
  await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    // AuditLog does not cascade from Workspace (it protects the log); the append-only trigger lets
    // these rows go only because this workspace's grace has ended by the database clock.
    await tx.auditLog.deleteMany({ where: { workspaceId } });
    await tx.workspace.deleteMany({ where: { id: workspaceId } });
    await tx.workspaceTombstone.update({
      where: { id: tombstoneId },
      data: { purgedAt, purgeCounts },
    });
  });
}
