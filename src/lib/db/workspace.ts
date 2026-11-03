import type { Workspace } from "@prisma/client";
import { rawDb } from "./raw";
import type { TenantContext } from "./scoped";

/**
 * The tenant root row. `Workspace` is not itself workspace-scoped, so these helpers are the only
 * way feature code reads or changes it — always and only the caller's own workspace.
 */
export function getOwnWorkspace(ctx: TenantContext): Promise<Workspace> {
  return rawDb.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId } });
}

export function updateOwnWorkspace(
  ctx: TenantContext,
  data: Pick<Workspace, "name" | "timezone" | "baseCurrency">,
): Promise<Workspace> {
  return rawDb.workspace.update({ where: { id: ctx.workspaceId }, data });
}

/**
 * Live workspaces and their time zones (global table; used to schedule each one's night run).
 * A workspace still in setup (M5 wizard) is not live until its Admin goes live.
 */
export function listActiveWorkspaces(): Promise<
  Array<Pick<Workspace, "id" | "slug" | "timezone">>
> {
  return rawDb.workspace.findMany({
    where: { status: "ACTIVE", setupPending: false },
    select: { id: true, slug: true, timezone: true },
    orderBy: { id: "asc" },
  });
}

export function findWorkspaceBySlug(slug: string): Promise<Workspace | null> {
  return rawDb.workspace.findUnique({ where: { slug } });
}

/**
 * M5 setup wizard: the caller's own workspace goes live (its nightly run is then scheduled).
 * Compare-and-set: true only for the one call that actually flipped it.
 */
export async function markWorkspaceLive(ctx: TenantContext): Promise<boolean> {
  const { count } = await rawDb.workspace.updateMany({
    where: { id: ctx.workspaceId, setupPending: true },
    data: { setupPending: false },
  });
  return count === 1;
}

/** Undo of markWorkspaceLive when what must accompany it (the audit row) could not be written. */
export async function markWorkspacePending(ctx: TenantContext): Promise<void> {
  await rawDb.workspace.update({ where: { id: ctx.workspaceId }, data: { setupPending: true } });
}
