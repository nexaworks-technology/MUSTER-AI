import type { BookScope, Role } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  can,
  ForbiddenError,
  PERMISSIONS,
  requirePermission,
  type Permission,
} from "../permissions";

/**
 * ARCHITECTURE §7.2, row by row. Cells: "all" = allowed across the workspace, "book" = allowed
 * within the CSM's book scope, "-" = denied. Revenue is separate: it follows the canViewRevenue
 * flag for every role.
 */
type Cell = "all" | "book" | "-";
const MATRIX: Record<Exclude<Permission, "revenue:view">, [Cell, Cell, Cell, Cell]> = {
  //                         Admin   Leader  CSM     Viewer
  "accounts:view": ["all", "all", "book", "all"],
  "accounts:edit": ["all", "all", "book", "-"],
  "pulse:set": ["all", "all", "book", "-"],
  "approvals:decide": ["all", "all", "book", "-"],
  "signals:markFalseAlarm": ["all", "all", "book", "-"],
  "plays:createDraft": ["all", "all", "all", "-"],
  "plays:publish": ["all", "all", "-", "-"],
  "plays:enableAutoSend": ["all", "-", "-", "-"],
  "healthModel:propose": ["all", "all", "-", "-"],
  "healthModel:activate": ["all", "-", "-", "-"],
  "integrations:manage": ["all", "-", "-", "-"],
  "workspace:manageUsers": ["all", "-", "-", "-"],
  "workspace:manageSettings": ["all", "-", "-", "-"],
  "data:exportDelete": ["all", "-", "-", "-"],
  "campaigns:draft": ["all", "all", "all", "-"],
  "campaigns:send": ["all", "all", "-", "-"],
  "reports:view": ["all", "all", "book", "all"],
  "audit:view": ["all", "all", "-", "-"],
  "audit:export": ["all", "-", "-", "-"],
};
const ROLES: Role[] = ["ADMIN", "CS_LEADER", "CSM", "VIEWER"];

const member = (role: Role, canViewRevenue = false, bookScope: BookScope = "OWN") => ({
  role,
  canViewRevenue,
  bookScope,
});

describe("permission matrix (ARCHITECTURE §7.2)", () => {
  it("covers every permission the code defines", () => {
    expect(new Set(PERMISSIONS)).toEqual(new Set([...Object.keys(MATRIX), "revenue:view"]));
  });

  for (const [permission, cells] of Object.entries(MATRIX)) {
    ROLES.forEach((role, i) => {
      const cell = cells[i]!;
      it(`${role} → ${permission}: ${cell}`, () => {
        const grant = can(member(role), permission as Permission);
        if (cell === "-") expect(grant).toBeNull();
        else if (cell === "all") expect(grant).toEqual({ scope: "ALL" });
        else expect(grant).toEqual({ scope: "OWN" });
      });
    });
  }
});

describe("book scope", () => {
  it("a CSM sees only their own book by default", () => {
    expect(can(member("CSM"), "accounts:view")).toEqual({ scope: "OWN" });
  });

  it("an admin can widen a CSM's book to TEAM or ALL", () => {
    expect(can(member("CSM", false, "TEAM"), "approvals:decide")).toEqual({ scope: "TEAM" });
    expect(can(member("CSM", false, "ALL"), "accounts:edit")).toEqual({ scope: "ALL" });
  });

  it("book scope never grants what the role lacks", () => {
    expect(can(member("CSM", false, "ALL"), "plays:publish")).toBeNull();
  });
});

describe("revenue permission", () => {
  it.each(ROLES)("%s with canViewRevenue may view revenue", (role) => {
    expect(can(member(role, true), "revenue:view")).toEqual({ scope: "ALL" });
  });

  it.each(ROLES)("%s without canViewRevenue may not, admins included", (role) => {
    expect(can(member(role, false), "revenue:view")).toBeNull();
  });
});

describe("requirePermission", () => {
  it("returns the grant when allowed", () => {
    expect(requirePermission(member("ADMIN"), "workspace:manageUsers")).toEqual({ scope: "ALL" });
  });

  it("throws ForbiddenError naming the permission when denied", () => {
    expect(() => requirePermission(member("VIEWER"), "accounts:edit")).toThrowError(ForbiddenError);
    expect(() => requirePermission(member("VIEWER"), "accounts:edit")).toThrowError(
      /accounts:edit/,
    );
  });

  it("a viewer can never mutate", () => {
    const mutating = PERMISSIONS.filter((p) => !p.endsWith(":view"));
    for (const p of mutating) expect(can(member("VIEWER", true, "ALL"), p)).toBeNull();
  });
});
