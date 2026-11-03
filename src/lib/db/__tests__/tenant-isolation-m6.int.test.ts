import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";

/**
 * Rule 2 for the M6 onboarding models (M6 rule 1, rule 7) and, since the post-M6 review (S2), the
 * Usage API's ledger `UsageIngestBatch`. Its own file, like M3–M5. The update
 * attack writes a real, harmless column on B's row (count 0) and the same write on A's own row
 * as the control (count 1). M6 keeps its attacks here rather than extending the shared helper.
 */
type Side = Awaited<ReturnType<typeof setup>>;
let A: Side;
let B: Side;

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const workspaceId = actor.workspaceId;
  const db = scopedDb(actor);
  const account = await db.account.create({
    data: {
      workspaceId,
      name: `${label} account`,
      tier: "MID_TOUCH",
      lifecycleStage: "ONBOARDING",
    },
  });
  const contact = await db.contact.create({
    data: {
      workspaceId,
      accountId: account.id,
      name: `${label} IT`,
      email: `it@${label.toLowerCase()}.test`,
    },
  });
  const template = await db.onboardingTemplate.create({
    data: { workspaceId, name: `${label} standard`, targetDays: 60 },
  });
  const plan = await db.onboardingPlan.create({
    data: {
      workspaceId,
      accountId: account.id,
      templateId: template.id,
      startDate: new Date("2026-10-01"),
      targetValueDate: new Date("2026-11-30"),
    },
  });
  const step = await db.onboardingStep.create({
    data: {
      workspaceId,
      planId: plan.id,
      key: "sso",
      position: 1,
      title: "SSO setup",
      ownerSide: "CUSTOMER",
      ownerContactId: contact.id,
      dueDate: new Date("2026-10-21"),
    },
  });
  const goal = await db.goal.create({
    data: {
      workspaceId,
      accountId: account.id,
      text: "Cut reporting time in half",
      sourceType: "Contract",
      sourceId: "c1",
    },
  });
  // The Usage API's ledger (B1): one integration and one applied batch per side.
  const integration = await db.integration.create({
    data: { workspaceId, provider: "USAGE_API" },
  });
  const usageBatch = await db.usageIngestBatch.create({
    data: { workspaceId, integrationId: integration.id, batchKey: "a".repeat(64), events: 3 },
  });
  return {
    actor,
    workspaceId,
    db,
    account,
    contact,
    template,
    plan,
    step,
    goal,
    integration,
    usageBatch,
  };
}

beforeAll(async () => {
  A = await setup("TenantM6A");
  B = await setup("TenantM6B");
});

type Delegate = {
  findMany: () => Promise<Array<{ workspaceId: string }>>;
  findUnique: (a: { where: { id: string } }) => Promise<unknown>;
  updateMany: (a: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => Promise<{ count: number }>;
  deleteMany: (a: { where: { id: string } }) => Promise<{ count: number }>;
};

const CASES = [
  {
    model: "OnboardingTemplate",
    delegate: "onboardingTemplate",
    row: (s: Side) => s.template,
    write: () => ({ targetDays: 45 }),
  },
  {
    model: "OnboardingPlan",
    delegate: "onboardingPlan",
    row: (s: Side) => s.plan,
    write: () => ({ stallReason: "attack-control" }),
  },
  {
    model: "OnboardingStep",
    delegate: "onboardingStep",
    row: (s: Side) => s.step,
    write: () => ({ blockedReason: "attack-control" }),
  },
  {
    model: "Goal",
    delegate: "goal",
    row: (s: Side) => s.goal,
    write: () => ({ quote: "attack-control" }),
  },
  {
    // Review S2: the ledger's real column, with the same own-row control (count 1) and delete attempt.
    model: "UsageIngestBatch",
    delegate: "usageIngestBatch",
    row: (s: Side) => s.usageBatch,
    write: () => ({ events: 99 }),
  },
] as const;

const fk = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";

describe("tenant isolation — M6 onboarding models (Rule 2)", () => {
  for (const c of CASES) {
    it(`${c.model}: A cannot read, update (real field) or delete B's row; A's own write lands`, async () => {
      const d = A.db[c.delegate] as unknown as Delegate;
      const bId = c.row(B).id;
      const rows = await d.findMany();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.workspaceId === A.workspaceId)).toBe(true);
      expect(await d.findUnique({ where: { id: bId } })).toBeNull();
      expect((await d.updateMany({ where: { id: bId }, data: c.write() })).count).toBe(0);
      expect((await d.updateMany({ where: { id: c.row(A).id }, data: c.write() })).count).toBe(1);
      expect((await d.deleteMany({ where: { id: bId } })).count).toBe(0);
      expect(
        await (B.db[c.delegate] as unknown as Delegate).findUnique({ where: { id: bId } }),
      ).not.toBeNull();
    });

    it(`${c.model}: raw SQL without the workspace setting sees nothing`, async () => {
      const rows = await rawDb.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${c.model}"`,
      );
      expect(Number(rows[0]?.n)).toBe(0);
    });
  }

  it("plans, steps and goals cannot point into another workspace (composite FKs)", async () => {
    const ws = A.workspaceId;
    await expect(
      A.db.onboardingPlan.create({
        data: {
          workspaceId: ws,
          accountId: B.account.id,
          startDate: new Date("2026-10-01"),
          targetValueDate: new Date("2026-11-01"),
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.onboardingPlan.create({
        data: {
          workspaceId: ws,
          accountId: A.account.id,
          templateId: B.template.id,
          startDate: new Date("2026-10-01"),
          targetValueDate: new Date("2026-11-01"),
          status: "CANCELLED",
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.onboardingStep.create({
        data: {
          workspaceId: ws,
          planId: B.plan.id,
          key: "x",
          position: 9,
          title: "x",
          ownerSide: "US",
          dueDate: new Date("2026-10-10"),
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.onboardingStep.create({
        data: {
          workspaceId: ws,
          planId: A.plan.id,
          key: "y",
          position: 9,
          title: "y",
          ownerSide: "CUSTOMER",
          ownerContactId: B.contact.id,
          dueDate: new Date("2026-10-10"),
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.onboardingStep.create({
        data: {
          workspaceId: ws,
          planId: A.plan.id,
          key: "z",
          position: 9,
          title: "z",
          ownerSide: "US",
          ownerMembershipId: B.actor.membershipId,
          dueDate: new Date("2026-10-10"),
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.goal.create({ data: { workspaceId: ws, accountId: B.account.id, text: "x" } }),
    ).rejects.toSatisfy(fk);
  });

  it("a usage batch cannot point at another workspace's integration (composite FK), and its row is B's alone", async () => {
    await expect(
      A.db.usageIngestBatch.create({
        data: {
          workspaceId: A.workspaceId,
          integrationId: B.integration.id,
          batchKey: "b".repeat(64),
          events: 1,
        },
      }),
    ).rejects.toSatisfy(fk);
    // B's row is exactly as B left it after every attack above.
    expect(
      (await B.db.usageIngestBatch.findUniqueOrThrow({ where: { id: B.usageBatch.id } })).events,
    ).toBe(3);
  });

  it("the database refuses a step done without how (D1), a product completion without proof, and a second open plan", async () => {
    await expect(
      A.db.onboardingStep.update({ where: { id: A.step.id }, data: { doneAt: new Date() } }),
    ).rejects.toThrow(/onboarding_step_done_has_how/);
    await expect(
      A.db.onboardingStep.update({
        where: { id: A.step.id },
        data: { doneAt: new Date(), completedVia: "HUMAN" },
      }),
    ).rejects.toThrow(/onboarding_step_human_has_member/);
    await expect(
      A.db.onboardingStep.update({
        where: { id: A.step.id },
        data: { doneAt: new Date(), completedVia: "PRODUCT_EVENT" },
      }),
    ).rejects.toThrow(/onboarding_step_event_has_evidence/);
    await expect(
      A.db.onboardingPlan.create({
        data: {
          workspaceId: A.workspaceId,
          accountId: A.account.id,
          startDate: new Date("2026-10-02"),
          targetValueDate: new Date("2026-12-01"),
        },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002",
    ); // onboarding_plan_one_open
    await expect(
      A.db.onboardingPlan.update({
        where: { id: A.plan.id },
        data: { valueReachedAt: new Date("2026-10-20") },
      }),
    ).rejects.toThrow(/onboarding_plan_value_has_evidence/);
    await expect(
      A.db.goal.create({
        data: { workspaceId: A.workspaceId, accountId: A.account.id, text: "x", origin: "AI" },
      }),
    ).rejects.toThrow(/goal_agent_run_required/);
  });
});
