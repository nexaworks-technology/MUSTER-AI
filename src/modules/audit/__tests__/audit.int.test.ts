import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { writeAudit } from "@/lib/audit";
import { ForbiddenError } from "@/lib/auth/permissions";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { exportAudit, listAudit } from "../service";

/**
 * The audit viewer and export (spec §6N2; M4 acceptance #11): Admins and CS Leaders view, only
 * Admins export, the export is itself audited, filters narrow by actor, action prefix and target,
 * and CSV cells that a spreadsheet would run as formulas are neutralised.
 */
let admin: Actor;
let leader: Actor;
let csm: Actor;

async function member(ws: string, role: "CS_LEADER" | "CSM", name: string): Promise<Actor> {
  const user = await rawDb.user.create({ data: { email: `${name}-${randomUUID()}@t.test`, name } });
  const m = await scopedDb({ workspaceId: ws }).membership.create({
    data: { workspaceId: ws, userId: user.id, role },
  });
  return {
    workspaceId: ws,
    userId: user.id,
    membershipId: m.id,
    role,
    canViewRevenue: false,
    bookScope: "OWN",
  };
}

beforeAll(async () => {
  ({ actor: admin } = await createTestAdmin("Audit"));
  leader = await member(admin.workspaceId, "CS_LEADER", "Dana");
  csm = await member(admin.workspaceId, "CSM", "Leo");
  const ws = admin.workspaceId;
  await writeAudit({
    workspaceId: ws,
    actorType: "AGENT",
    actorId: "health-analyst",
    action: "agent.run.succeeded",
    targetType: "AgentRun",
    targetId: "r1",
    summary: "run ok",
  });
  await writeAudit({
    workspaceId: ws,
    actorType: "USER",
    actorId: leader.userId,
    action: "approval.approved",
    targetType: "Approval",
    targetId: "a1",
    summary: "Approved: check-in",
  });
  await writeAudit({
    workspaceId: ws,
    actorType: "SYSTEM",
    action: "outbound.sent",
    targetType: "OutboundMessage",
    targetId: "o1",
    summary: '=HYPERLINK("x") sent',
  });
  await writeAudit({
    workspaceId: ws,
    actorType: "USER",
    actorId: admin.userId,
    action: "workspace.updated",
    summary: "Profile changed",
  });
});

describe("audit viewer", () => {
  it("filters by several action prefixes, newest first, with actor names", async () => {
    const page = await listAudit(leader, { action: "agent.run,approval.,outbound." });
    expect(page.rows.map((r) => r.action)).toEqual([
      "outbound.sent",
      "approval.approved",
      "agent.run.succeeded",
    ]);
    expect(page.rows.find((r) => r.action === "approval.approved")!.actorLabel).toBe("Dana");
    expect(page.rows.find((r) => r.action === "agent.run.succeeded")!.actorLabel).toBe(
      "AI: health-analyst",
    );
  });

  it("filters by person name, actor type and target", async () => {
    expect((await listAudit(admin, { actor: "Dana" })).rows.map((r) => r.action)).toEqual([
      "approval.approved",
    ]);
    expect((await listAudit(admin, { actorType: "AGENT" })).total).toBe(1);
    expect((await listAudit(admin, { targetId: "o1" })).rows.map((r) => r.targetType)).toEqual([
      "OutboundMessage",
    ]);
  });

  it("a CSM cannot view it", async () => {
    await expect(listAudit(csm, {})).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("audit export", () => {
  it("exports CSV and JSON for Admins, neutralises formulas, and audits the export", async () => {
    const csv = await exportAudit(admin, { action: "outbound." }, "csv");
    expect(csv.count).toBe(1);
    expect(csv.contentType).toContain("text/csv");
    const lines = csv.body.split("\r\n");
    expect(lines[0]).toBe(
      "createdAt,actorType,actorId,actor,action,targetType,targetId,agentRunId,summary,before,after",
    );
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"") sent"`);
    const json = await exportAudit(admin, {}, "json");
    expect(JSON.parse(json.body).length).toBeGreaterThanOrEqual(5);
    const logged = await listAudit(admin, { action: "audit.exported" });
    expect(logged.rows.map((r) => r.summary)).toEqual(
      expect.arrayContaining(["Exported 1 audit row(s) as CSV", expect.stringMatching(/as JSON$/)]),
    );
  });

  it("a CS Leader can view but not export", async () => {
    await expect(exportAudit(leader, {}, "csv")).rejects.toBeInstanceOf(ForbiddenError);
  });
});
