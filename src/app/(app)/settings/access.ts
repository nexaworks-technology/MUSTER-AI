import "server-only";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { can, type MemberAccess, type Permission } from "@/lib/auth/permissions";
import { requireSession, resolveWorkspaceContext, type WorkspaceContext } from "@/lib/auth/session";

/** Settings tabs and the permission each needs. A member sees only the tabs they may use. */
export const SETTINGS_TABS: ReadonlyArray<{ label: string; href: Route; permission: Permission }> =
  [
    { label: "Users", href: "/settings/users", permission: "workspace:manageUsers" },
    { label: "Workspace", href: "/settings/workspace", permission: "workspace:manageSettings" },
    { label: "Import", href: "/settings/import", permission: "data:import" },
    { label: "Data quality", href: "/settings/data-quality", permission: "data:import" },
    { label: "Integrations", href: "/settings/integrations", permission: "integrations:manage" },
    { label: "Data health", href: "/settings/data-health", permission: "data:import" },
    { label: "Signals", href: "/settings/signals", permission: "healthModel:propose" },
    { label: "Health model", href: "/settings/health-model", permission: "healthModel:propose" },
    { label: "AI team", href: "/settings/ai-team", permission: "audit:view" },
    { label: "Audit", href: "/settings/audit", permission: "audit:view" },
    // Last on purpose: /settings opens the first allowed tab, which stays Users for Admins.
    { label: "Setup", href: "/setup", permission: "workspace:manageSettings" },
  ];

export const allowedSettingsTabs = (member: MemberAccess) =>
  SETTINGS_TABS.filter((t) => can(member, t.permission));

/**
 * Settings pages render concurrently with their layout, so each page checks access itself:
 * without the permission, the page does not exist for this user (404, matching the hidden nav).
 * Called with no permission, it admits anyone who can use at least one settings tab.
 */
export async function requireSettingsAccess(permission?: Permission): Promise<WorkspaceContext> {
  const ctx = await resolveWorkspaceContext(await requireSession());
  if (!ctx) notFound();
  const allowed = permission ? can(ctx, permission) !== null : allowedSettingsTabs(ctx).length > 0;
  if (!allowed) notFound();
  return ctx;
}
