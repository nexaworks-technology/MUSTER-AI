import type { BookScope, Role } from "@prisma/client";

/**
 * Server-side permission map — ARCHITECTURE §7.2. Checked on every Server Action and Route
 * Handler via requirePermission(ctx, permission). The client never decides access.
 */
export const PERMISSIONS = [
  "accounts:view",
  "accounts:edit",
  "pulse:set",
  "approvals:decide",
  "signals:markFalseAlarm",
  "plays:createDraft",
  "plays:publish",
  "plays:enableAutoSend",
  "healthModel:propose",
  "healthModel:activate",
  "integrations:manage",
  "workspace:manageUsers",
  "workspace:manageSettings",
  "data:exportDelete",
  "data:import",
  "campaigns:draft",
  "campaigns:send",
  "reports:view",
  "audit:view",
  "audit:export",
  "revenue:view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** What a grant covers. OWN/TEAM narrow book-scoped work to the member's accounts. */
export interface Grant {
  scope: BookScope;
}

export interface MemberAccess {
  role: Role;
  canViewRevenue: boolean;
  bookScope: BookScope;
}

/** "all" = whole workspace; "book" = the member's book scope; absent = denied. */
type Access = "all" | "book";
type RoleTable = Partial<Record<Role, Access>>;

const ADMIN_ONLY: RoleTable = { ADMIN: "all" };
const LEADERS: RoleTable = { ADMIN: "all", CS_LEADER: "all" };
const LEADERS_AND_CSM_BOOK: RoleTable = { ADMIN: "all", CS_LEADER: "all", CSM: "book" };
const LEADERS_AND_CSM: RoleTable = { ADMIN: "all", CS_LEADER: "all", CSM: "all" };

const TABLE: Record<Exclude<Permission, "revenue:view">, RoleTable> = {
  "accounts:view": { ...LEADERS_AND_CSM_BOOK, VIEWER: "all" },
  "accounts:edit": LEADERS_AND_CSM_BOOK,
  "pulse:set": LEADERS_AND_CSM_BOOK,
  "approvals:decide": LEADERS_AND_CSM_BOOK,
  "signals:markFalseAlarm": LEADERS_AND_CSM_BOOK,
  "plays:createDraft": LEADERS_AND_CSM,
  "plays:publish": LEADERS,
  "plays:enableAutoSend": ADMIN_ONLY,
  "healthModel:propose": LEADERS,
  "healthModel:activate": ADMIN_ONLY,
  "integrations:manage": ADMIN_ONLY,
  "workspace:manageUsers": ADMIN_ONLY,
  "workspace:manageSettings": ADMIN_ONLY,
  "data:exportDelete": ADMIN_ONLY,
  /** CSV import (M2, DECISIONS D-46): data owners — Admin and CS Leader. */
  "data:import": LEADERS,
  "campaigns:draft": LEADERS_AND_CSM,
  "campaigns:send": LEADERS,
  "reports:view": { ...LEADERS_AND_CSM_BOOK, VIEWER: "all" },
  "audit:view": LEADERS,
  "audit:export": ADMIN_ONLY,
};

export class ForbiddenError extends Error {
  constructor(readonly permission: Permission) {
    super(`Not allowed: ${permission}`);
    this.name = "ForbiddenError";
  }
}

export function can(member: MemberAccess, permission: Permission): Grant | null {
  // Financial views follow the per-membership flag for every role (spec §6N5).
  if (permission === "revenue:view") return member.canViewRevenue ? { scope: "ALL" } : null;
  const access = TABLE[permission][member.role];
  if (!access) return null;
  return { scope: access === "all" ? "ALL" : member.bookScope };
}

export function requirePermission(member: MemberAccess, permission: Permission): Grant {
  const grant = can(member, permission);
  if (!grant) throw new ForbiddenError(permission);
  return grant;
}
