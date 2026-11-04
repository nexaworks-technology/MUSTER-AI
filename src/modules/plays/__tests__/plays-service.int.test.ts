import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { rawDb } from "@/lib/db/raw";
import { createTestAdmin } from "@/test/fixtures";
import type { PlayDefinition } from "../definition";
import {
  duplicatePlay,
  getPlay,
  killPlay,
  listPlays,
  pausePlay,
  plainLanguageSummary,
  previewRetroactiveAccounts,
  publishPlay,
  revertPlayVersion,
} from "../service";

async function createActorWithRole(workspaceId: string, role: "ADMIN" | "CS_LEADER" | "CSM" | "VIEWER") {
  const user = await rawDb.user.create({
    data: {
      email: `${role.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`,
      name: `Test ${role}`,
    },
  });
  const membership = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx.membership.create({
      data: {
        workspaceId,
        userId: user.id,
        role,
        canViewRevenue: true,
      },
    });
  });
  return {
    workspaceId,
    userId: user.id,
    membershipId: membership.id,
    role: membership.role,
    canViewRevenue: membership.canViewRevenue,
    bookScope: membership.bookScope,
    user: { id: user.id, email: user.email, name: user.name },
  };
}

const safePlayDef: PlayDefinition = {
  name: "Safe Test Play",
  description: "A test play that is completely safe",
  trigger: { type: "signal", ruleKey: "health_risk_signal" },
  steps: [
    {
      key: "task-step",
      name: "Assign investigation task",
      handler: "task",
      params: { title: "Investigate account health" },
      approvalLevelByTier: {
        HIGH_TOUCH: "NOTIFY_ONLY",
        MID_TOUCH: "NOTIFY_ONLY",
        LONG_TAIL: "NOTIFY_ONLY",
      },
      safe: true,
      sensitive: false,
    },
  ],
};

describe("S8: Plays Management Service & UI Operations (spec §5, §6J1-4)", () => {
  it("listPlays and getPlay return play details, versions, status, and plain-language summary", async () => {
    const { workspace, actor: admin } = await createTestAdmin("ListGetPlayTest");
    const db = scopedDb(admin);

    const play = await db.play.create({
      data: {
        workspaceId: workspace.id,
        key: "test-play-1",
        name: safePlayDef.name,
        description: safePlayDef.description,
        category: "HEALTH",
        status: "DRAFT",
      },
    });

    await db.playVersion.create({
      data: {
        workspaceId: workspace.id,
        playId: play.id,
        version: 1,
        definition: safePlayDef as unknown as Prisma.InputJsonValue,
      },
    });

    const list = await listPlays(admin);
    expect(list.length).toBeGreaterThanOrEqual(1);
    const item = list.find((p) => p.id === play.id);
    expect(item).toBeDefined();
    expect(item?.name).toBe("Safe Test Play");
    expect(item?.version).toBe(1);
    expect(item?.status).toBe("DRAFT");

    const details = await getPlay(admin, play.id);
    expect(details.id).toBe(play.id);
    expect(details.versions).toHaveLength(1);
    expect(details.summary).toBeTruthy();
    expect(details.summary).toContain("Assign investigation task");
  });

  it("duplicatePlay copies play definition into a new DRAFT play with isSeeded=false and audit row", async () => {
    const { workspace, actor: admin } = await createTestAdmin("DuplicatePlayTest");
    const csm = await createActorWithRole(workspace.id, "CSM");
    const viewer = await createActorWithRole(workspace.id, "VIEWER");
    const db = scopedDb(admin);

    const origPlay = await db.play.create({
      data: {
        workspaceId: workspace.id,
        key: "orig-play",
        name: "Original Play",
        status: "PUBLISHED",
        isSeeded: true,
      },
    });
    await db.playVersion.create({
      data: {
        workspaceId: workspace.id,
        playId: origPlay.id,
        version: 1,
        definition: safePlayDef as unknown as Prisma.InputJsonValue,
      },
    });

    // Viewer cannot duplicate (needs plays:createDraft)
    await expect(duplicatePlay(viewer, origPlay.id)).rejects.toThrow(ForbiddenError);

    // CSM can duplicate
    const duplicated = await duplicatePlay(csm, origPlay.id, { name: "Custom Copy" });
    expect(duplicated.name).toBe("Custom Copy");
    expect(duplicated.status).toBe("DRAFT");
    expect(duplicated.isSeeded).toBe(false);
    expect(duplicated.key).not.toBe(origPlay.key);

    const dupDetails = await getPlay(csm, duplicated.id);
    expect(dupDetails.versions).toHaveLength(1);
    expect(dupDetails.versions[0]!.version).toBe(1);
    expect((dupDetails.versions[0]!.definition as unknown as PlayDefinition).name).toBe(safePlayDef.name);

    // Verify audit log
    const audit = await db.auditLog.findFirst({
      where: {
        workspaceId: workspace.id,
        action: "play.duplicated",
        targetId: duplicated.id,
      },
    });
    expect(audit).toBeDefined();
    expect(audit?.actorId).toBe(csm.userId);
  });

  it("pausePlay and killPlay change status and audit; killPlay exits running runs", async () => {
    const { workspace, actor: admin } = await createTestAdmin("PauseKillPlayTest");
    const csLeader = await createActorWithRole(workspace.id, "CS_LEADER");
    const csm = await createActorWithRole(workspace.id, "CSM");
    const db = scopedDb(admin);

    const play = await db.play.create({
      data: {
        workspaceId: workspace.id,
        key: "pause-kill-play",
        name: "Pause Kill Play",
        status: "PUBLISHED",
      },
    });
    const version = await db.playVersion.create({
      data: {
        workspaceId: workspace.id,
        playId: play.id,
        version: 1,
        definition: safePlayDef as unknown as Prisma.InputJsonValue,
      },
    });
    await db.play.update({
      where: { id: play.id },
      data: { currentVersionId: version.id },
    });

    const account = await db.account.create({
      data: {
        workspaceId: workspace.id,
        name: "Account for Pause Kill",
        tier: "HIGH_TOUCH",
      },
    });

    const run = await db.playRun.create({
      data: {
        workspaceId: workspace.id,
        playId: play.id,
        playVersionId: version.id,
        accountId: account.id,
        triggerRef: "test-run-1",
        status: "RUNNING",
      },
    });

    // CSM cannot pause or kill
    await expect(pausePlay(csm, play.id)).rejects.toThrow(ForbiddenError);
    await expect(killPlay(csm, play.id)).rejects.toThrow(ForbiddenError);

    // CS Leader pauses
    await pausePlay(csLeader, play.id);
    let p = await db.play.findUniqueOrThrow({ where: { id: play.id } });
    expect(p.status).toBe("PAUSED");

    const pauseAudit = await db.auditLog.findFirst({
      where: { workspaceId: workspace.id, action: "play.paused", targetId: play.id },
    });
    expect(pauseAudit).toBeDefined();

    // CS Leader kills
    await killPlay(csLeader, play.id);
    p = await db.play.findUniqueOrThrow({ where: { id: play.id } });
    expect(p.status).toBe("KILLED");

    const killAudit = await db.auditLog.findFirst({
      where: { workspaceId: workspace.id, action: "play.killed", targetId: play.id },
    });
    expect(killAudit).toBeDefined();

    // Running run must be transitioned to EXITED
    const updatedRun = await db.playRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.status).toBe("EXITED");
    expect(updatedRun.exitReason).toBe("Play killed");
  });

  it("revertPlayVersion creates a new PlayVersion copying a previous version definition", async () => {
    const { workspace, actor: admin } = await createTestAdmin("RevertVersionTest");
    const db = scopedDb(admin);

    const play = await db.play.create({
      data: {
        workspaceId: workspace.id,
        key: "revert-test-play",
        name: "Revert Test Play",
        status: "DRAFT",
      },
    });

    const defV1 = { ...safePlayDef, description: "Version 1 description" };
    const defV2 = { ...safePlayDef, description: "Version 2 description" };

    await db.playVersion.create({
      data: {
        workspaceId: workspace.id,
        playId: play.id,
        version: 1,
        definition: defV1 as unknown as Prisma.InputJsonValue,
      },
    });
    await db.playVersion.create({
      data: {
        workspaceId: workspace.id,
        playId: play.id,
        version: 2,
        definition: defV2 as unknown as Prisma.InputJsonValue,
      },
    });

    // Revert back to v1
    const reverted = await revertPlayVersion(admin, play.id, 1);
    expect(reverted.version).toBe(3);
    expect((reverted.definition as unknown as PlayDefinition).description).toBe("Version 1 description");

    const audit = await db.auditLog.findFirst({
      where: { workspaceId: workspace.id, action: "play.version_reverted", targetId: play.id },
    });
    expect(audit).toBeDefined();
  });

  it("publishPlay with retroactive=true (D4) enters matching accounts and writes audited summary", async () => {
    const { workspace, actor: admin } = await createTestAdmin("RetroactivePublishTest");
    const db = scopedDb(admin);

    // Create 3 accounts
    const acc1 = await db.account.create({
      data: { workspaceId: workspace.id, name: "Acc 1", tier: "HIGH_TOUCH" },
    });
    const acc2 = await db.account.create({
      data: { workspaceId: workspace.id, name: "Acc 2", tier: "MID_TOUCH" },
    });
    const acc3 = await db.account.create({
      data: { workspaceId: workspace.id, name: "Acc 3", tier: "LONG_TAIL" },
    });

    // Acc 1 and Acc 2 have open signals matching ruleKey "health_risk_signal"
    await db.signal.create({
      data: {
        workspaceId: workspace.id,
        accountId: acc1.id,
        ruleKey: "health_risk_signal",
        ruleVersion: 1,
        category: "USAGE",
        severity: "CRITICAL",
        polarity: "RISK",
        status: "OPEN",
        title: "Health Risk Acc 1",
        explanation: "Risk detected",
        evidence: [{ sourceType: "HealthScore", value: 45, date: "2026-11-02" }],
        values: { current: 45 },
        params: {},
        dedupeKey: `sig-${Date.now()}-1`,
        firstSeenAt: new Date("2026-11-02"),
        lastSeenAt: new Date("2026-11-02"),
      },
    });

    await db.signal.create({
      data: {
        workspaceId: workspace.id,
        accountId: acc2.id,
        ruleKey: "health_risk_signal",
        ruleVersion: 1,
        category: "USAGE",
        severity: "CRITICAL",
        polarity: "RISK",
        status: "OPEN",
        title: "Health Risk Acc 2",
        explanation: "Risk detected",
        evidence: [{ sourceType: "HealthScore", value: 40, date: "2026-11-02" }],
        values: { current: 40 },
        params: {},
        dedupeKey: `sig-${Date.now()}-2`,
        firstSeenAt: new Date("2026-11-02"),
        lastSeenAt: new Date("2026-11-02"),
      },
    });

    const play = await db.play.create({
      data: {
        workspaceId: workspace.id,
        key: "retro-play",
        name: "Retro Play",
        status: "DRAFT",
      },
    });

    await db.playVersion.create({
      data: {
        workspaceId: workspace.id,
        playId: play.id,
        version: 1,
        definition: safePlayDef as unknown as Prisma.InputJsonValue,
      },
    });

    // Preview matching accounts
    const preview = await previewRetroactiveAccounts(admin, play.id);
    expect(preview.count).toBe(2);
    expect(preview.accountIds).toContain(acc1.id);
    expect(preview.accountIds).toContain(acc2.id);
    expect(preview.accountIds).not.toContain(acc3.id);

    // Publish with retroactive: true
    const pub = await publishPlay(admin, play.id, { retroactive: true });
    expect(pub.status).toBe("PUBLISHED");

    // Both accounts should have entered a PlayRun
    const runs = await db.playRun.findMany({
      where: { workspaceId: workspace.id, playId: play.id },
    });
    expect(runs).toHaveLength(2);
    const runAccountIds = runs.map((r) => r.accountId);
    expect(runAccountIds).toContain(acc1.id);
    expect(runAccountIds).toContain(acc2.id);

    // Check audit
    const pubAudit = await db.auditLog.findFirst({
      where: { workspaceId: workspace.id, action: "play.published", targetId: play.id },
    });
    expect(pubAudit).toBeDefined();
    expect((pubAudit?.after as Record<string, unknown>).retroactive).toBe(true);
    expect((pubAudit?.after as Record<string, unknown>).enteredCount).toBe(2);
  });

  it("plainLanguageSummary formats conditions, triggers, wait steps, and actions into plain English", () => {
    const summary = plainLanguageSummary(safePlayDef);
    expect(summary).toContain("Trigger: Signal");
    expect(summary).toContain("health_risk_signal");
    expect(summary).toContain("Assign investigation task");
  });
});
