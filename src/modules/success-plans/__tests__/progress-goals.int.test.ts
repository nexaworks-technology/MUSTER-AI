import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { createSuccessPlan, getAccountSuccessPlan } from "../service";

/**
 * DEMO-WALKTHROUGH FAIL 40: Orchid & Vale › Plans said "Progress: 0%" with 1 of 3 goals achieved:
 * progress counted milestones only. It now counts the plan's goals too (achieved = done; a dropped
 * goal is no longer part of the plan), and says what it counted.
 */
async function world(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const account = await db.account.create({
    data: { workspaceId: actor.workspaceId, name: `${label} Partners`, tier: "HIGH_TOUCH" },
  });
  const goal = (successPlanId: string, text: string, status: "OPEN" | "ACHIEVED" | "DROPPED") =>
    db.goal.create({
      data: { workspaceId: actor.workspaceId, accountId: account.id, successPlanId, text, status },
    });
  return { actor, account, goal };
}

describe("success plan progress", () => {
  it("counts achieved goals when the plan has no milestones", async () => {
    const w = await world("ProgGoals");
    const plan = await createSuccessPlan(w.actor, { accountId: w.account.id, title: "FY27" });
    await w.goal(plan.id, "Close in 5 days", "ACHIEVED");
    await w.goal(plan.id, "Automate reconciliations", "OPEN");
    await w.goal(plan.id, "Train the team", "OPEN");
    const v = (await getAccountSuccessPlan(w.actor, w.account.id))!;
    expect(v.progressPercent).toBe(33);
    expect(v.progressBasis).toEqual({
      milestones: 0,
      milestonesDone: 0,
      goals: 3,
      goalsAchieved: 1,
    });
  });

  it("counts milestones and goals together; a dropped goal is left out", async () => {
    const w = await world("ProgBoth");
    const plan = await createSuccessPlan(w.actor, {
      accountId: w.account.id,
      title: "Rollout",
      milestones: [
        { id: "m1", title: "SSO", completed: true },
        { id: "m2", title: "Pilot", completed: false },
      ],
    });
    await w.goal(plan.id, "Adopt dashboards", "ACHIEVED");
    await w.goal(plan.id, "Old idea", "DROPPED");
    const v = (await getAccountSuccessPlan(w.actor, w.account.id))!;
    expect(v.progressPercent).toBe(67); // 2 of 3
    expect(v.plan.progressPercent).toBe(67);
  });

  it("a plan with nothing to count yet is 0%, with nothing counted", async () => {
    const w = await world("ProgEmpty");
    await createSuccessPlan(w.actor, { accountId: w.account.id, title: "Empty" });
    const v = (await getAccountSuccessPlan(w.actor, w.account.id))!;
    expect(v.progressPercent).toBe(0);
    expect(v.progressBasis).toEqual({
      milestones: 0,
      milestonesDone: 0,
      goals: 0,
      goalsAchieved: 0,
    });
  });
});
