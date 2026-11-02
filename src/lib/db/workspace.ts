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

/** Active workspaces and their time zones (global table; used to schedule each one's night run). */
export function listActiveWorkspaces(): Promise<
  Array<Pick<Workspace, "id" | "slug" | "timezone">>
> {
  return rawDb.workspace.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, slug: true, timezone: true },
    orderBy: { id: "asc" },
  });
}

export function findWorkspaceBySlug(slug: string): Promise<Workspace | null> {
  return rawDb.workspace.findUnique({ where: { slug } });
}
