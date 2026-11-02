import "server-only";
import { notFound } from "next/navigation";
import { can, type Permission } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext, type WorkspaceContext } from "@/lib/auth/session";

/**
 * Settings pages render concurrently with their layout, so each page checks access itself:
 * without the permission, Settings does not exist for this user (404, matching the hidden nav).
 */
export async function requireSettingsAccess(
  permission: Permission = "workspace:manageUsers",
): Promise<WorkspaceContext> {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx || !can(ctx, permission)) notFound();
  return ctx;
}
