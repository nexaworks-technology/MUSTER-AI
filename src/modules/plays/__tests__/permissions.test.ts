import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { rawDb } from "@/lib/db/raw";
import { createTestAdmin, createTestWorkspace } from "@/test/fixtures";
import {
  CONFIRM_ENABLE_AUTO_SEND,
  disableAutoSend,
  enableAutoSend,
  getSettingsData,
} from "@/modules/settings/service";
import { publishPlay } from "../service";
import type { PlayDefinition } from "../definition";

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

describe("S6: Plays permissions & auto-send enablement (spec §6J4, ARCH §7.2)", () => {
  it("Admin enables auto-send with typed confirmation; audit log is written", async () => {
    const { workspace, actor: admin } = await createTestAdmin("AutoSendAdmin");
    const db = scopedDb(admin);

    // Initial state: autoSendEnabled is false
    const initialSettings = await getSettingsData(workspace.id);
    expect(initialSettings.outbound.autoSendEnabled).toBe(false);

    // Rejects incorrect confirmation
    await expect(
      enableAutoSend(admin, { confirmation: "yes please" }),
    ).rejects.toThrow(/Typed confirmation required/);

    // Succeeds with exact confirmation
    const res = await enableAutoSend(admin, { confirmation: CONFIRM_ENABLE_AUTO_SEND });
    expect(res.autoSendEnabled).toBe(true);

    // Setting is persisted
    const updatedSettings = await getSettingsData(workspace.id);
    expect(updatedSettings.outbound.autoSendEnabled).toBe(true);
    expect(updatedSettings.approvals.workspaceCeiling).toBe("SEND_AUTOMATICALLY");

    // Audit log was written
    const audit = await db.auditLog.findFirstOrThrow({
      where: {
        workspaceId: workspace.id,
        action: "settings.auto_send_enabled",
      },
    });
    expect(audit.summary).toContain("Enabled auto-send");
    expect(audit.actorId).toBe(admin.userId);

    // Admin can disable auto-send
    await disableAutoSend(admin);
    const disabledSettings = await getSettingsData(workspace.id);
    expect(disabledSettings.outbound.autoSendEnabled).toBe(false);

    const disableAudit = await db.auditLog.findFirstOrThrow({
      where: {
        workspaceId: workspace.id,
        action: "settings.auto_send_disabled",
      },
    });
    expect(disableAudit.summary).toContain("Disabled auto-send");
  });

  it("Non-admins (CS Leader, CSM, Viewer) cannot enable auto-send", async () => {
    const { workspace } = await createTestAdmin("NonAdminPerms");
    const csLeader = await createActorWithRole(workspace.id, "CS_LEADER");
    const csm = await createActorWithRole(workspace.id, "CSM");
    const viewer = await createActorWithRole(workspace.id, "VIEWER");

    await expect(
      enableAutoSend(csLeader, { confirmation: CONFIRM_ENABLE_AUTO_SEND }),
    ).rejects.toThrow(ForbiddenError);

    await expect(
      enableAutoSend(csm, { confirmation: CONFIRM_ENABLE_AUTO_SEND }),
    ).rejects.toThrow(ForbiddenError);

    await expect(
      enableAutoSend(viewer, { confirmation: CONFIRM_ENABLE_AUTO_SEND }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("CS Leader can publish plays; CSM and Viewer cannot publish", async () => {
    const { workspace, actor: admin } = await createTestAdmin("PlayPublishPerms");
    const csLeader = await createActorWithRole(workspace.id, "CS_LEADER");
    const csm = await createActorWithRole(workspace.id, "CSM");
    const viewer = await createActorWithRole(workspace.id, "VIEWER");

    const db = scopedDb(admin);
    const playDef: PlayDefinition = {
      name: "Publish Perm Play",
      trigger: { type: "signal", ruleKey: "test_rule" },
      steps: [
        {
          key: "notify-step",
          name: "Notify",
          handler: "notify",
          params: { message: "Test" },
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

    const play = await db.play.create({
      data: {
        workspaceId: workspace.id,
        key: `play-${Date.now()}`,
        name: playDef.name,
      },
    });
    await db.playVersion.create({
      data: {
        workspaceId: workspace.id,
        playId: play.id,
        version: 1,
        definition: playDef as any,
      },
    });

    // CSM and Viewer cannot publish
    await expect(publishPlay(csm, play.id)).rejects.toThrow(ForbiddenError);
    await expect(publishPlay(viewer, play.id)).rejects.toThrow(ForbiddenError);

    // CS Leader can publish
    const pub = await publishPlay(csLeader, play.id);
    expect(pub.status).toBe("PUBLISHED");
  });
});
