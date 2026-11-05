import { describe, expect, it } from "vitest";
import type { BookScope, Role } from "@prisma/client";
import {
  can,
  PERMISSIONS,
  requirePermission,
  ForbiddenError,
  type Permission,
} from "../permissions";

/**
 * M12 A7 (test-first): the RBAC matrix of ARCHITECTURE §7.2, written out by hand FROM THE DOC as
 * an independent table (it deliberately does not import or mirror the TABLE in permissions.ts).
 *
 *   none = ✗   all = whole workspace   book = the member's own book scope (bookScope)
 *
 * Rows the doc does not name are listed in UNSPECIFIED_BY_DOC and asserted separately so that a
 * new permission can never be added without a decision here.
 */
type Cell = "none" | "all" | "book";
const ROLES: Role[] = ["ADMIN", "CS_LEADER", "CSM", "VIEWER"];
const SCOPES: BookScope[] = ["OWN", "TEAM", "ALL"];

// Column order: Admin, CS Leader, CSM, Viewer.
const DOC: Record<
  Exclude<Permission, "revenue:view" | "data:import" | "workspace:manageSettings">,
  [Cell, Cell, Cell, Cell]
> = {
  // "View accounts / Account 360": all | all | own book (configurable TEAM/ALL) | all (read-only)
  "accounts:view": ["all", "all", "book", "all"],
  // "Edit accounts, contacts, notes, tasks": ✓ | ✓ | own book | ✗
  "accounts:edit": ["all", "all", "book", "none"],
  // "CSM Pulse"
  "pulse:set": ["all", "all", "book", "none"],
  // "Decide approvals"
  "approvals:decide": ["all", "all", "book", "none"],
  // "Mark signal false alarm"
  "signals:markFalseAlarm": ["all", "all", "book", "none"],
  // "Create/publish plays, enable auto-send": ✓ | create + publish; auto-send ✗ | create drafts | ✗
  "plays:createDraft": ["all", "all", "all", "none"],
  "plays:publish": ["all", "all", "none", "none"],
  "plays:enableAutoSend": ["all", "none", "none", "none"],
  // "Health model edit/activate": ✓ | propose; activate ✗ | ✗ | ✗
  "healthModel:propose": ["all", "all", "none", "none"],
  "healthModel:activate": ["all", "none", "none", "none"],
  // "Integrations connect / write-back toggle"
  "integrations:manage": ["all", "none", "none", "none"],
  // "Users, roles, data controls, export/delete"
  "workspace:manageUsers": ["all", "none", "none", "none"],
  "data:exportDelete": ["all", "none", "none", "none"],
  // "Campaign send": ✓ | ✓ | draft only | ✗
  "campaigns:send": ["all", "all", "none", "none"],
  "campaigns:draft": ["all", "all", "all", "none"],
  // "Reports (non-financial)": ✓ | ✓ | own book | ✓
  "reports:view": ["all", "all", "book", "all"],
  // "Audit log view/export": ✓ | view | ✗ | ✗
  "audit:view": ["all", "all", "none", "none"],
  "audit:export": ["all", "none", "none", "none"],
};

/** Permissions the §7.2 table has no row for; the expectation is the code's documented intent. */
const UNSPECIFIED_BY_DOC: Record<
  "data:import" | "workspace:manageSettings",
  [Cell, Cell, Cell, Cell]
> = {
  // DECISIONS D-46 (CSV import: data owners, Admin and CS Leader); not a §7.2 row.
  "data:import": ["all", "all", "none", "none"],
  // §7.2 groups "Users, roles, data controls" as Admin-only; workspace settings follow it.
  "workspace:manageSettings": ["all", "none", "none", "none"],
};

function member(role: Role, bookScope: BookScope, canViewRevenue = false) {
  return { role, bookScope, canViewRevenue };
}

function expectCell(role: Role, permission: Permission, cell: Cell) {
  for (const bookScope of SCOPES) {
    const grant = can(member(role, bookScope), permission);
    if (cell === "none") expect(grant, `${role} ${permission}`).toBeNull();
    else if (cell === "all") expect(grant, `${role} ${permission}`).toEqual({ scope: "ALL" });
    else
      expect(grant, `${role} ${permission} bookScope=${bookScope}`).toEqual({ scope: bookScope });
  }
}

describe("RBAC matrix (ARCHITECTURE §7.2)", () => {
  for (const [permission, cells] of Object.entries(DOC) as [
    Permission,
    [Cell, Cell, Cell, Cell],
  ][]) {
    for (const [i, role] of ROLES.entries()) {
      it(`${role} · ${permission} = ${cells[i]}`, () => {
        expectCell(role, permission, cells[i]!);
      });
    }
  }

  for (const [permission, cells] of Object.entries(UNSPECIFIED_BY_DOC) as [
    Permission,
    [Cell, Cell, Cell, Cell],
  ][]) {
    for (const [i, role] of ROLES.entries()) {
      it(`(not a §7.2 row) ${role} · ${permission} = ${cells[i]}`, () => {
        expectCell(role, permission, cells[i]!);
      });
    }
  }

  it("covers every permission in PERMISSIONS exactly once, and nothing else", () => {
    const covered = [
      ...Object.keys(DOC),
      ...Object.keys(UNSPECIFIED_BY_DOC),
      "revenue:view",
    ].sort();
    expect(covered).toEqual([...PERMISSIONS].sort());
  });

  it("revenue:view follows the per-membership flag for every role, never the role", () => {
    for (const role of ROLES) {
      for (const bookScope of SCOPES) {
        expect(can(member(role, bookScope, true), "revenue:view"), `${role} flag on`).toEqual({
          scope: "ALL",
        });
        expect(can(member(role, bookScope, false), "revenue:view"), `${role} flag off`).toBeNull();
      }
    }
  });

  it("requirePermission throws ForbiddenError exactly where can() is null, and returns the grant otherwise", () => {
    for (const role of ROLES) {
      for (const permission of PERMISSIONS) {
        const m = member(role, "OWN");
        const grant = can(m, permission);
        if (grant) expect(requirePermission(m, permission)).toEqual(grant);
        else expect(() => requirePermission(m, permission)).toThrow(ForbiddenError);
      }
    }
  });
});
