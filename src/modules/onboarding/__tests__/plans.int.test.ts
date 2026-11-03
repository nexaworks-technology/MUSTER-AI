import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { countQueries } from "@/test/query-counter";
import { createTestAdmin } from "@/test/fixtures";
import { AccountNotFoundError } from "@/modules/accounts/service";
import {
  chooseTemplate,
  createPlan,
  getAccountOnboarding,
  listOnboarding,
  markStepDone,
  saveTemplate,
  updateStep,
} from "../service";

/**
 * Plans, steps and templates on the database: a plan comes from the template chosen by plan then
 * tier; a person marks a step done (HUMAN, audited); book scope and roles hold; /onboarding pages
 * in a fixed number of queries (acceptance #13).
 */
const clock = () => new Date("2026-11-02T17:00:00Z");

async function setup(label: string) {
  const { actor, workspace } = await createTestAdmin(label);
  const ws = actor.workspaceId;
  const db = scopedDb(actor);
  await saveTemplate(actor, {
    name: "Mid-touch standard (60d)",
    forTier: "MID_TOUCH",
    targetDays: 60,
    steps: [
      { key: "kickoff", title: "Kickoff call", ownerSide: "US", dueDay: 3 },
      { key: "sso", title: "SSO setup", ownerSide: "CUSTOMER", dueDay: 21 },
      {
        key: "first_dashboard",
        title: "First dashboard",
        ownerSide: "CUSTOMER",
        dueDay: 21,
        completesWhen: { metric: "featureUsed", featureKey: "dashboards" },
      },
    ],
    valueDefinition: [{ metric: "keyFeaturesUsed", min: 2 }],
  });
  const mk = (name: string) =>
    db.account.create({
      data: {
        workspaceId: ws,
        name,
        tier: "MID_TOUCH",
        plan: "Growth",
        lifecycleStage: "ONBOARDING",
        ownerMembershipId: actor.membershipId,
      },
    });
  return { actor, workspace, ws, db, mk };
}

describe("onboarding plans", () => {
  it("chooses the template by plan, then tier, then a general one", () => {
    const t = (id: string, forPlan: string | null, forTier: string | null) => ({
      id,
      forPlan,
      forTier,
      archivedAt: null,
    });
    const all = [
      t("general", null, null),
      t("mid", null, "MID_TOUCH"),
      t("growth", "Growth", null),
    ];
    expect(chooseTemplate(all, { tier: "MID_TOUCH", plan: "Growth" })?.id).toBe("growth");
    expect(chooseTemplate(all, { tier: "MID_TOUCH", plan: "Starter" })?.id).toBe("mid");
    expect(chooseTemplate(all, { tier: "LONG_TAIL", plan: "Starter" })?.id).toBe("general");
  });

  it("creates the plan with dated steps, the owner on our steps, the product condition kept; one open plan per account", async () => {
    const S = await setup("PlanCreate");
    const a = await S.mk("Pinecrest");
    const plan = await createPlan(S.actor, a.id, { startDate: "2026-09-30" }, clock);
    const steps = await S.db.onboardingStep.findMany({
      where: { planId: plan.id },
      orderBy: { position: "asc" },
    });
    expect(
      steps.map((s) => [s.key, s.dueDate.toISOString().slice(0, 10), s.ownerMembershipId]),
    ).toEqual([
      ["kickoff", "2026-10-03", S.actor.membershipId],
      ["sso", "2026-10-21", null],
      ["first_dashboard", "2026-10-21", null],
    ]);
    expect(steps[2]!.completesWhen).toEqual({
      metric: "featureUsed",
      featureKey: "dashboards",
      minDays: 1,
    });
    expect(plan.targetValueDate.toISOString().slice(0, 10)).toBe("2026-11-29");
    await expect(createPlan(S.actor, a.id, {}, clock)).rejects.toThrow(
      "This account already has an open onboarding plan.",
    );
  });

  it("a person marks a step done (HUMAN, audited); a blocked reason is recorded; the view shows it", async () => {
    const S = await setup("PlanStep");
    const a = await S.mk("Ridgeback");
    const plan = await createPlan(S.actor, a.id, { startDate: "2026-10-05" }, clock);
    const [kickoff, sso] = await S.db.onboardingStep.findMany({
      where: { planId: plan.id },
      orderBy: { position: "asc" },
    });
    await markStepDone(S.actor, kickoff!.id, clock);
    await updateStep(S.actor, sso!.id, { blockedReason: "waiting on legal review" });
    const v = await getAccountOnboarding(S.actor, a.id, clock);
    expect(v.plan!.steps[0]).toMatchObject({
      completedVia: "HUMAN",
      completedByMembershipId: S.actor.membershipId,
    });
    expect(v.plan!.steps[1]).toMatchObject({
      blockedReason: "waiting on legal review",
      doneAt: null,
    });
    expect(v.valueText).toBe("2 key features of the plan used");
    expect(
      await S.db.auditLog.count({
        where: { action: "onboarding.step_completed", targetId: kickoff!.id },
      }),
    ).toBe(1);
    await expect(markStepDone(S.actor, kickoff!.id, clock)).rejects.toThrow(
      "This step is already done.",
    );
  });

  it("book scope and roles: a CSM outside the book cannot see or edit; only leaders edit templates", async () => {
    const S = await setup("PlanScope");
    const a = await S.mk("Lumen");
    await createPlan(S.actor, a.id, {}, clock);
    const user = await rawDb.user.create({ data: { email: `csm-${S.ws}@x.test`, name: "Other" } });
    const m = await rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${S.ws}, true)`;
      return tx.membership.create({
        data: { workspaceId: S.ws, userId: user.id, role: "CSM", bookScope: "OWN" },
      });
    });
    const csm = {
      ...S.actor,
      userId: user.id,
      membershipId: m.id,
      role: "CSM" as const,
      bookScope: "OWN" as const,
    };
    await expect(getAccountOnboarding(csm, a.id, clock)).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
    expect((await listOnboarding(csm, {}, clock)).rows).toEqual([]);
    await expect(
      saveTemplate(csm, {
        name: "x",
        targetDays: 10,
        steps: [{ key: "a", title: "A", ownerSide: "US", dueDay: 1 }],
        valueDefinition: [],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("/onboarding lists stalled first and takes the same number of queries for 2 and 5 plans (no N+1)", async () => {
    const S = await setup("PlanList");
    const accounts = [];
    for (let i = 0; i < 5; i++) accounts.push(await S.mk(`Acct ${i}`));
    for (const a of accounts) await createPlan(S.actor, a.id, { startDate: "2026-10-01" }, clock);
    await S.db.onboardingPlan.updateMany({
      where: { accountId: accounts[3]!.id },
      data: { status: "STALLED", stallReason: "SSO setup (customer) overdue 12 days" },
    });
    const two = await countQueries(() => listOnboarding(S.actor, { tier: "MID_TOUCH" }, clock));
    expect(two.result.rows[0]).toMatchObject({
      status: "STALLED",
      blocker: "SSO setup (customer) overdue 12 days",
      day: 32,
    });
    expect(two.result.rows).toHaveLength(5);
    // Fewer plans on the page → the same number of queries.
    await S.db.onboardingPlan.updateMany({
      where: { accountId: { in: accounts.slice(2).map((a) => a.id) } },
      data: { status: "CANCELLED" },
    });
    const fewer = await countQueries(() => listOnboarding(S.actor, {}, clock));
    expect(fewer.result.rows).toHaveLength(2);
    expect(fewer.queries).toBe(two.queries);
  });
});
