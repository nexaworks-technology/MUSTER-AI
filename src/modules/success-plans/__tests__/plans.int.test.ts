import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import {
  createSuccessPlan,
  getAccountSuccessPlan,
  updateSuccessPlan,
} from "../service";

describe("Slice 9: Success Plans & Account 360 Tab", () => {
  it("creates a success plan with milestones, default sharedWithPortal=false, and audits creation", async () => {
    const { actor: admin } = await createTestAdmin("plan-create");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Acme Success Plan",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });

    const plan = await createSuccessPlan(admin, {
      accountId: account.id,
      title: "Q4 2026 Enterprise Rollout",
      milestones: [
        { id: "m1", title: "SSO Configured", targetDate: "2026-11-15", completed: true },
        { id: "m2", title: "Pilot Team 20 Users", targetDate: "2026-12-01", completed: false },
        { id: "m3", title: "Full Team Rollout", targetDate: "2026-12-15", completed: false },
      ],
    });

    expect(plan.id).toBeDefined();
    expect(plan.title).toBe("Q4 2026 Enterprise Rollout");
    expect(plan.sharedWithPortal).toBe(false);
    expect(plan.status).toBe("ACTIVE");
    expect(plan.progressPercent).toBe(33); // 1 of 3

    // Audit log written
    const auditLogs = await db.auditLog.findMany({
      where: { workspaceId: admin.workspaceId, targetId: plan.id },
    });
    expect(auditLogs.length).toBeGreaterThanOrEqual(1);
    expect(auditLogs[0]!.action).toBe("success_plan.created");
  });

  it("updates milestones and updates progress calculation", async () => {
    const { actor: admin } = await createTestAdmin("plan-update");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Progress Account",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });

    const plan = await createSuccessPlan(admin, {
      accountId: account.id,
      title: "Adoption Plan",
      milestones: [
        { id: "m1", title: "Kickoff", targetDate: "2026-11-01", completed: true },
        { id: "m2", title: "Training", targetDate: "2026-11-10", completed: false },
      ],
    });

    const updated = await updateSuccessPlan(admin, plan.id, {
      milestones: [
        { id: "m1", title: "Kickoff", targetDate: "2026-11-01", completed: true },
        { id: "m2", title: "Training", targetDate: "2026-11-10", completed: true },
      ],
    });

    expect(updated.progressPercent).toBe(100);
  });

  it("toggles sharedWithPortal and logs audit event", async () => {
    const { actor: admin } = await createTestAdmin("plan-portal-toggle");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Portal Share Account",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });

    const plan = await createSuccessPlan(admin, {
      accountId: account.id,
      title: "Shared Plan",
      sharedWithPortal: false,
      milestones: [],
    });

    const updated = await updateSuccessPlan(admin, plan.id, {
      sharedWithPortal: true,
    });
    expect(updated.sharedWithPortal).toBe(true);

    const auditLogs = await db.auditLog.findMany({
      where: {
        workspaceId: admin.workspaceId,
        targetId: plan.id,
        action: "success_plan.portal_sharing_changed",
      },
    });
    expect(auditLogs.length).toBe(1);
    expect((auditLogs[0]!.after as Record<string, unknown>).sharedWithPortal).toBe(true);
  });

  it("getAccountSuccessPlan retrieves plan, milestones and linked goals in a bounded query count", async () => {
    const { actor: admin } = await createTestAdmin("plan-read");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Read Account",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });

    const plan = await createSuccessPlan(admin, {
      accountId: account.id,
      title: "Main Plan",
      milestones: [
        { id: "m1", title: "Setup", targetDate: "2026-11-01", completed: true },
      ],
    });

    // Create a goal linked to this plan
    await db.goal.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        text: "Achieve 50 active users",
        status: "OPEN",
        successPlanId: plan.id,
      },
    });

    const planView = await getAccountSuccessPlan(admin, account.id);
    expect(planView).not.toBeNull();
    expect(planView!.plan.id).toBe(plan.id);
    expect(planView!.milestones).toHaveLength(1);
    expect(planView!.goals).toHaveLength(1);
    expect(planView!.goals[0]!.text).toBe("Achieve 50 active users");
  });
});
