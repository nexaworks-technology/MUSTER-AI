import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin, createTestUser } from "@/test/fixtures";
import { enterPlay, publishPlay, type PlayDefinition } from "../service";

/**
 * DEMO-WALKTHROUGH FAIL 24: play drafts were created with no assignee, so they sat in nobody's
 * queue, while agent drafts on the same accounts went to the owner. A play draft is assigned like
 * every other approval: the account's owner, else the first CS Leader, else the first Admin.
 */
const def: PlayDefinition = {
  name: "Champion Loss",
  trigger: { type: "signal", ruleKey: "champion_left" },
  steps: [
    {
      key: "draft",
      name: "Draft an introduction",
      handler: "draft",
      params: { mode: "template", subject: "Hello", body: "Hi {{contact.first_name}}." },
      approvalLevelByTier: {
        HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
        MID_TOUCH: "DRAFT_FOR_APPROVAL",
        LONG_TAIL: "DRAFT_FOR_APPROVAL",
      },
      safe: true,
      sensitive: false,
    },
  ],
};

async function world(label: string, owned: boolean) {
  const { workspace, actor, membership } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const user = await createTestUser(`${label}-csm`);
  const csm = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
    return tx.membership.create({
      data: { workspaceId: workspace.id, userId: user.id, role: "CSM", bookScope: "OWN" },
    });
  });
  const account = await db.account.create({
    data: {
      workspaceId: workspace.id,
      name: `${label} Freight`,
      tier: "HIGH_TOUCH",
      ownerMembershipId: owned ? csm.id : null,
    },
  });
  await db.contact.create({
    data: {
      workspaceId: workspace.id,
      accountId: account.id,
      name: "Delia Marsh",
      email: "d@h.test",
    },
  });
  const play = await db.play.create({
    data: { workspaceId: workspace.id, key: `cl-${label}`, name: def.name },
  });
  await db.playVersion.create({
    data: {
      workspaceId: workspace.id,
      playId: play.id,
      version: 1,
      definition: def as unknown as Prisma.InputJsonValue,
    },
  });
  await publishPlay(actor, play.id);
  const res = await enterPlay(
    actor,
    {
      workspaceId: workspace.id,
      playId: play.id,
      accountId: account.id,
      triggerRef: `sig-${label}`,
    },
    { executeInline: true, autoSendEnabled: false },
  );
  const step = await db.playStepRun.findFirstOrThrow({ where: { playRunId: res.playRunId! } });
  const approval = await db.approval.findUniqueOrThrow({ where: { id: step.approvalId! } });
  return { admin: membership, csm, approval };
}

describe("play drafts are assigned", () => {
  it("to the account's owner", async () => {
    const w = await world("PlayAssignOwned", true);
    expect(w.approval.status).toBe("PENDING");
    expect(w.approval.assigneeId).toBe(w.csm.id);
  });

  it("to the first leader or admin when the account has no owner, never to nobody", async () => {
    const w = await world("PlayAssignPool", false);
    expect(w.approval.assigneeId).toBe(w.admin.id);
  });
});
