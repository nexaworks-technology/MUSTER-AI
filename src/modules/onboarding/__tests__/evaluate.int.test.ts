import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Worker, type Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { closeQueues, getQueue, queuePrefix, redisConnection } from "@/lib/jobs/queues";
import { createTestAdmin } from "@/test/fixtures";
import { createPipelineProcessors } from "@/modules/signals/service";

/**
 * `onboarding.evaluate` inside the nightly chunk, through the real queue (M6 A4): the plan's
 * stall status comes from the shared definition and the onboarding signals open from the same
 * facts (D4); a product event completes a step with its evidence (D1); value reached closes the
 * plan with evidence (D3) and its stall signals resolve; a re-run of the same night changes
 * nothing. Health scores are never written by onboarding (rule 5).
 */
vi.hoisted(() => {
  process.env.QUEUE_PREFIX = "nexaworks-onboarding-eval-test";
});

const AS_OF = "2026-11-02";
const pipeline = createPipelineProcessors({ clock: () => new Date("2026-11-02T17:00:00Z") });
const workers: Worker<unknown, unknown>[] = [];

beforeAll(() => {
  const opts = { connection: redisConnection(), prefix: queuePrefix() };
  workers.push(
    new Worker(
      "signals",
      async (job: Job): Promise<unknown> => pipeline.signals[job.name]!(job),
      opts,
    ),
    new Worker(
      "health",
      async (job: Job): Promise<unknown> => pipeline.health[job.name]!(job),
      opts,
    ),
  );
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});

async function idle() {
  for (let i = 0; i < 300; i++) {
    const counts = await Promise.all(
      (["signals", "health"] as const).map((q) =>
        getQueue(q).getJobCounts("waiting", "active", "delayed", "prioritized"),
      ),
    );
    if (counts.every((c) => Object.values(c).every((n) => n === 0))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("queues did not drain");
}

let n = 0;
async function night(workspaceId: string) {
  await getQueue("signals").add(
    "nightly.kickoff",
    { workspaceId, asOf: AS_OF, runId: `night-${++n}` },
    { jobId: `${workspaceId}.kickoff.night-${n}` },
  );
  await idle();
}

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const ws = actor.workspaceId;
  const db = scopedDb(actor);
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: `${label} Health`,
      tier: "MID_TOUCH",
      plan: "Growth",
      lifecycleStage: "ONBOARDING",
      ownerMembershipId: actor.membershipId,
    },
  });
  const it = await db.contact.create({
    data: { workspaceId: ws, accountId: account.id, name: "Raj Patel", email: "raj@x.test" },
  });
  await db.contract.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      startDate: new Date("2026-09-30"),
      seatsPurchased: 15,
      valueMinor: 2_800_000n,
      currency: "USD",
    },
  });
  await db.featureCatalog.createMany({
    data: [
      {
        workspaceId: ws,
        featureKey: "dashboards",
        label: "Dashboards",
        isKeyFeature: true,
        includedInPlans: ["Growth"],
      },
      {
        workspaceId: ws,
        featureKey: "data_connectors",
        label: "Data connectors",
        isKeyFeature: true,
        includedInPlans: ["Growth"],
      },
    ],
  });
  const template = await db.onboardingTemplate.create({
    data: {
      workspaceId: ws,
      name: "Mid-touch standard (60d)",
      forTier: "MID_TOUCH",
      targetDays: 60,
      valueDefinition: [{ metric: "keyFeaturesUsed", min: 2 }],
    },
  });
  const plan = await db.onboardingPlan.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      templateId: template.id,
      startDate: new Date("2026-09-30"),
      targetValueDate: new Date("2026-11-29"),
    },
  });
  const sso = await db.onboardingStep.create({
    data: {
      workspaceId: ws,
      planId: plan.id,
      key: "sso",
      position: 1,
      title: "SSO setup",
      ownerSide: "CUSTOMER",
      ownerContactId: it.id,
      dueDate: new Date("2026-10-21"),
    },
  });
  const dash = await db.onboardingStep.create({
    data: {
      workspaceId: ws,
      planId: plan.id,
      key: "first_dashboard",
      position: 2,
      title: "First dashboard built",
      ownerSide: "CUSTOMER",
      dueDate: new Date("2026-11-15"),
      completesWhen: { metric: "featureUsed", featureKey: "dashboards", minDays: 1 },
    },
  });
  // People log in every day, so only the overdue step stalls the plan.
  await db.usageDaily.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      workspaceId: ws,
      accountId: account.id,
      date: new Date(Date.UTC(2026, 9, 3 + i)),
      activeUsers: 3,
      sessions: 3,
      events: 10,
    })),
  });
  return { actor, ws, db, account, plan, sso, dash };
}

let S: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  S = await setup("OnbEval");
});

describe("onboarding.evaluate in the nightly chunk", () => {
  it("a customer step 12 days overdue stalls the plan and opens the onboarding signals from the same facts", async () => {
    await night(S.ws);
    const plan = await S.db.onboardingPlan.findUniqueOrThrow({ where: { id: S.plan.id } });
    expect(plan).toMatchObject({
      status: "STALLED",
      stallReason: "SSO setup (customer) overdue 12 days",
    });
    const keys = (
      await S.db.signal.findMany({ where: { accountId: S.account.id, status: "OPEN" } })
    )
      .map((s) => s.ruleKey)
      .sort();
    expect(keys).toEqual(["onboarding_stall", "onboarding_step_overdue_customer"]);
    const stall = await S.db.signal.findFirstOrThrow({ where: { ruleKey: "onboarding_stall" } });
    expect(stall.title).toBe("Onboarding stalled: SSO setup (customer) overdue 12 days");
    expect(JSON.stringify(stall.evidence)).toContain(S.sso.id);
    expect(
      await rawDb.outboxEvent.count({ where: { workspaceId: S.ws, type: "onboarding.stalled" } }),
    ).toBe(1);
  });

  it("re-running the same night changes nothing", async () => {
    const before = {
      plan: await S.db.onboardingPlan.findUniqueOrThrow({ where: { id: S.plan.id } }),
      signals: await S.db.signal.count(),
      audits: await S.db.auditLog.count({ where: { action: { startsWith: "onboarding." } } }),
    };
    await night(S.ws);
    const after = await S.db.onboardingPlan.findUniqueOrThrow({ where: { id: S.plan.id } });
    expect(after.updatedAt).toEqual(before.plan.updatedAt);
    expect(await S.db.signal.count()).toBe(before.signals);
    expect(await S.db.auditLog.count({ where: { action: { startsWith: "onboarding." } } })).toBe(
      before.audits,
    );
  });

  it("a product event completes its step with the proving row as evidence (D1), audited", async () => {
    const row = await S.db.featureUsageDaily.create({
      data: {
        workspaceId: S.ws,
        accountId: S.account.id,
        featureKey: "dashboards",
        date: new Date("2026-10-28"),
        users: 2,
        events: 5,
      },
    });
    await night(S.ws);
    const step = await S.db.onboardingStep.findUniqueOrThrow({ where: { id: S.dash.id } });
    expect(step).toMatchObject({
      completedVia: "PRODUCT_EVENT",
      completedByMembershipId: null,
      doneAt: new Date("2026-10-28T00:00:00Z"),
    });
    expect(step.evidence).toEqual([
      { sourceType: "FeatureUsageDaily", sourceId: row.id, value: 2, date: "2026-10-28" },
    ]);
    expect(
      await S.db.auditLog.count({
        where: { action: "onboarding.step_completed", targetId: S.dash.id },
      }),
    ).toBe(1);
    // The overdue human step is not touched by any product event.
    expect(
      (await S.db.onboardingStep.findUniqueOrThrow({ where: { id: S.sso.id } })).doneAt,
    ).toBeNull();
  });

  it("value reached closes the plan with evidence (D3); its stall signals resolve; no health score is written by onboarding", async () => {
    const second = await S.db.featureUsageDaily.create({
      data: {
        workspaceId: S.ws,
        accountId: S.account.id,
        featureKey: "data_connectors",
        date: new Date("2026-10-31"),
        users: 1,
        events: 2,
      },
    });
    await night(S.ws);
    const plan = await S.db.onboardingPlan.findUniqueOrThrow({ where: { id: S.plan.id } });
    expect(plan).toMatchObject({
      status: "COMPLETE",
      valueReachedAt: new Date("2026-10-31T00:00:00Z"),
      stallReason: null,
    });
    expect(JSON.stringify(plan.valueEvidence)).toContain(second.id);
    expect(
      await S.db.signal.count({
        where: { accountId: S.account.id, status: "OPEN", ruleKey: { startsWith: "onboarding_" } },
      }),
    ).toBe(0);
    expect(await S.db.auditLog.count({ where: { action: "onboarding.value_reached" } })).toBe(1);
    // Rule 5: the onboarding module never writes health; health reads the data on its own schedule.
    const dir = path.resolve(import.meta.dirname, "..");
    const code = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(path.join(dir, f), "utf8"));
    expect(code.some((c) => /healthScoreSnapshot|healthReason/.test(c))).toBe(false);
  });
});
