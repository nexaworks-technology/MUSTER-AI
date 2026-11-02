import { rawDb } from "../../src/lib/db/raw";

/** Reads a workspace's audit actions through RLS, exactly as the app would. */
export async function auditActions(workspaceSlug: string): Promise<string[]> {
  const ws = await rawDb.workspace.findUniqueOrThrow({ where: { slug: workspaceSlug } });
  const [, rows] = await rawDb.$transaction([
    rawDb.$executeRaw`SELECT set_config('app.workspace_id', ${ws.id}, true)`,
    rawDb.auditLog.findMany({ where: { workspaceId: ws.id }, select: { action: true } }),
  ]);
  return rows.map((r) => r.action);
}

export async function tryToEditAuditLog(workspaceSlug: string): Promise<string> {
  const ws = await rawDb.workspace.findUniqueOrThrow({ where: { slug: workspaceSlug } });
  try {
    await rawDb.$transaction([
      rawDb.$executeRaw`SELECT set_config('app.workspace_id', ${ws.id}, true)`,
      rawDb.$executeRaw`UPDATE "AuditLog" SET summary = 'tampered' WHERE "workspaceId" = ${ws.id}`,
    ]);
    return "update succeeded";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export { rawDb };
