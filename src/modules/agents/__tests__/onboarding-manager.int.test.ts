import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import { addDays, businessClock, todayIn, utcMidnight } from "@/lib/dates";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { runAgent } from "../executor";
import { onboardingManager } from "../definitions/onboarding-manager";
import { renderableRun } from "../service";

/**
 * M6 §5 Onboarding Manager (RecordedProvider-style fake): the output validates; a citation to an
 * id outside the bundle is UNCITED and nothing is rendered; a model-supplied number is overwritten
 * by code; the draft lands in Approvals and nothing is sent; our-side delays escalate and never
 * write to the customer; nothing is marked done (D-100); another workspace's plan is unreachable.
 */
type World = Awaited<ReturnType<typeof world>>;
const TODAY = todayIn("UTC", businessClock);
const ago = (n: number) => utcMidnight(addDays(TODAY, -n));

async function world(label: string, opts: { ourSide?: boolean } = {}) {
  const { actor, user } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const csmUser = await rawDb.user.create({
    data: { email: `${label.toLowerCase()}-aisha-${randomUUID().slice(0, 8)}@t.test`, name: "Aisha Bello" },
  });
  const csm = await db.membership.create({
    data: { workspaceId: ws, userId: csmUser.id, role: "CSM" },
  });
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Pinecrest Health",
      tier: "MID_TOUCH",
      plan: "Growth",
      ownerMembershipId: csm.id,
    },
  });
  const it = await db.contact.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      name: "Raj Menon",
      title: "IT administrator",
      email: "raj@pinecrest-health.test",
    },
  });
  const usage = await db.usageDaily.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      date: ago(9),
      activeUsers: 1,
      sessions: 1,
      events: 4,
    },
  });
  const text = opts.ourSide
    ? "Sandbox access (us) overdue 12 days"
    : "SSO setup (customer) overdue 12 days";
  const plan = await db.onboardingPlan.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      startDate: ago(34),
      targetValueDate: ago(-5),
      status: "STALLED",
      stallReason: text,
      blockers: [
        {
          kind: opts.ourSide ? "STEP_OVERDUE_US" : "STEP_OVERDUE_CUSTOMER",
          text,
          days: 12,
          sources: [{ sourceType: "UsageDaily", sourceId: usage.id, value: 1, date: "x" }],
        },
      ],
    },
  });
  const step = await db.onboardingStep.create({
    data: {
      workspaceId: ws,
      planId: plan.id,
      key: "sso",
      position: 1,
      title: opts.ourSide ? "Sandbox access" : "SSO setup",
      ownerSide: opts.ourSide ? "US" : "CUSTOMER",
      ownerMembershipId: opts.ourSide ? csm.id : null,
      ownerContactId: opts.ourSide ? null : it.id,
      dueDate: ago(12),
    },
  });
  return { actor, user, db, csm, account, it, usage, plan, step };
}

function provider(output: (ids: Record<string, string>) => unknown) {
  const seen: string[] = [];
  const p: AiProvider = {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      seen.push(req.input);
      const ids: Record<string, string> = {};
      for (const m of req.input.matchAll(/"sourceType": "([^"]+)",\s+"sourceId": "([^"]+)"/g))
        ids[m[1]!] ??= m[2]!;
      return {
        output: output(ids) as T,
        stopReason: "end_turn",
        model: "model-from-env-standard",
        requestId: null,
        inputTokens: 5,
        outputTokens: 5,
        latencyMs: 1,
      };
    },
  };
  return { p, seen };
}

const good = (ids: Record<string, string>, over: Record<string, unknown> = {}) => ({
  reasoningSummary: "The SSO step the customer owns is overdue and nobody has used the product.",
  confidence: 0.7,
  citations: [
    { sourceType: "OnboardingPlan", sourceId: ids.OnboardingPlan },
    { sourceType: "OnboardingStep", sourceId: ids.OnboardingStep },
    { sourceType: "UsageDaily", sourceId: ids.UsageDaily },
  ],
  proposedActions: [],
  subject: "Getting SSO set up",
  body: "Hi Raj,\n\nThe SSO setup has been waiting for 12 days. Is something in the way? I can join a short call this week.\n\nAisha",
  escalation: { needed: false, note: null },
  ...over,
});

const run = (w: World, p: AiProvider, id = "t1") =>
  runAgent(
    w.actor,
    onboardingManager,
    { planId: w.plan.id, reason: "stalled" },
    { type: "onboarding.stalled", id },
    { provider: p },
  );

let W: World;
beforeAll(async () => {
  W = await world("MgrA");
});

describe("Onboarding Manager (M6 §5)", () => {
  it("validates, drafts the check-in into Approvals, and sends nothing", async () => {
    const { p, seen } = provider((ids) => good(ids));
    const out = await run(W, p);
    expect(out).toMatchObject({ kind: "run", status: "SUCCEEDED" });
    // It was given the plan, the overdue step, the IT contact and the usage day: nothing else.
    expect(seen[0]).toContain("SSO setup");
    expect(seen[0]).toContain('"daysOverdue": 12');
    const r = await W.db.agentRun.findFirstOrThrow({ where: { agentKey: "onboarding-manager" } });
    expect(r.actionTaken).toBe("APPROVAL_REQUESTED");
    const approval = await W.db.approval.findFirstOrThrow({
      where: { proposedByAgentRunId: r.id },
    });
    expect(approval).toMatchObject({
      kind: "SEND_EMAIL",
      status: "PENDING",
      requiredLevel: "DRAFT_FOR_APPROVAL",
    });
    expect(approval.reason).toContain("SSO setup (customer) overdue 12 days");
    expect(JSON.stringify(approval.proof)).toContain(W.step.id);
    const message = await W.db.outboundMessage.findFirstOrThrow({
      where: { approvalId: approval.id },
    });
    expect(message).toMatchObject({
      status: "AWAITING_APPROVAL",
      toEmail: "raj@pinecrest-health.test",
      origin: "AI",
      agentRunId: r.id,
    });
    expect(message.sentAt).toBeNull();
  });

  it("records what Rule 5 asks for: prompt version, model, inputs, output, reasoning, confidence", async () => {
    const r = await W.db.agentRun.findFirstOrThrow({ where: { agentKey: "onboarding-manager" } });
    expect(r).toMatchObject({
      promptName: "onboarding-manager",
      promptVersion: "1.0.0",
      model: "model-from-env-standard",
      status: "SUCCEEDED",
    });
    expect(r.reasoningSummary).toBeTruthy();
    expect(r.confidence).not.toBeNull();
    expect(JSON.stringify(r.inputRefs)).toContain(W.plan.id);
    expect(r.output).not.toBeNull();
  });

  it("marks nothing done: the step and the plan are as they were", async () => {
    const step = await W.db.onboardingStep.findUniqueOrThrow({ where: { id: W.step.id } });
    expect(step.doneAt).toBeNull();
    const plan = await W.db.onboardingPlan.findUniqueOrThrow({ where: { id: W.plan.id } });
    expect(plan).toMatchObject({ status: "STALLED", valueReachedAt: null });
  });

  it("a citation to an id outside the bundle is UNCITED, nothing is rendered, nothing is written", async () => {
    const w = await world("MgrCite");
    const { p } = provider((ids) =>
      good(ids, {
        citations: [
          { sourceType: "OnboardingPlan", sourceId: ids.OnboardingPlan },
          { sourceType: "OnboardingStep", sourceId: "step_not_given" },
        ],
      }),
    );
    const out = await run(w, p);
    expect(out).toMatchObject({ kind: "run", status: "UNCITED" });
    if (out.kind !== "run") throw new Error("unreachable");
    expect(await renderableRun(w.actor, out.runId)).toBeNull();
    expect(await w.db.approval.count()).toBe(0);
    expect(await w.db.outboundMessage.count()).toBe(0);
    expect(await w.db.task.count()).toBe(0);
  });

  it("a number the model invents is UNCITED; the plan's own numbers are fine", async () => {
    const w = await world("MgrNum");
    const bad = await run(
      w,
      provider((ids) => good(ids, { body: "Hi Raj, SSO has been open for 40 days. Can we talk?" }))
        .p,
    );
    expect(bad).toMatchObject({ status: "UNCITED" });
    expect(await w.db.approval.count()).toBe(0);
  });

  it("overwrites a model-supplied count with the plan's own figure, and drops the rest", async () => {
    const w = await world("MgrFacts");
    const { p } = provider((ids) =>
      good(ids, {
        proposedActions: [
          {
            type: "ESCALATE",
            summary: "Ask the owner to step in",
            days: 99,
            count: 7,
            percent: 80,
            confidence: 0.1,
            amountMinor: 5,
          },
        ],
      }),
    );
    const out = await run(w, p);
    expect(out).toMatchObject({ status: "SUCCEEDED" });
    const r = await w.db.agentRun.findFirstOrThrow();
    const action = (r.output as { proposedActions: Array<Record<string, unknown>> })
      .proposedActions[0]!;
    expect(action.days).toBe(12);
    for (const f of ["count", "percent", "confidence", "amountMinor"])
      expect(action).not.toHaveProperty(f);
  });

  it("an overdue step on OUR side never writes to the customer: the owner gets a Task instead", async () => {
    const w = await world("MgrUs", { ourSide: true });
    const { p } = provider((ids) =>
      good(ids, { escalation: { needed: true, note: "Our sandbox step is late." } }),
    );
    const out = await run(w, p);
    expect(out).toMatchObject({ status: "SUCCEEDED" });
    expect(await w.db.approval.count()).toBe(0);
    expect(await w.db.outboundMessage.count()).toBe(0);
    const task = await w.db.task.findFirstOrThrow();
    expect(task).toMatchObject({
      ownerMembershipId: w.csm.id,
      origin: "AI",
      priority: "HIGH",
      title: "Onboarding at Pinecrest Health: Sandbox access (us) overdue 12 days",
    });
    expect(task.agentRunId).not.toBeNull();
    const r = await w.db.agentRun.findFirstOrThrow();
    expect(r.actionTaken).toBe("TASK_CREATED");
  });

  it("an escalation on a customer blocker makes the Task and the draft; running again changes nothing", async () => {
    const w = await world("MgrBoth");
    const { p } = provider((ids) =>
      good(ids, { escalation: { needed: true, note: "Stuck a long while." } }),
    );
    await run(w, p);
    const again = await run(w, p);
    expect(again).toMatchObject({ status: "SUCCEEDED", reused: true });
    expect(await w.db.task.count()).toBe(1);
    expect(await w.db.approval.count()).toBe(1);
    const notices = await w.db.notification.count({ where: { type: "TASK_ASSIGNED" } });
    expect(notices).toBe(1);
  });

  it("with nothing to say it drafts nothing (the correct answer)", async () => {
    const w = await world("MgrNone");
    const { p } = provider((ids) =>
      good(ids, {
        subject: null,
        body: null,
        escalation: { needed: false, note: null },
        insufficientData: { missing: ["No contact with an email address"] },
      }),
    );
    expect(await run(w, p)).toMatchObject({ status: "SUCCEEDED" });
    expect(await w.db.approval.count()).toBe(0);
    expect(await w.db.task.count()).toBe(0);
    expect((await w.db.agentRun.findFirstOrThrow()).actionTaken).toBe("NONE");
  });

  it("another workspace's plan is unreachable: the run is given nothing and cannot cite it", async () => {
    const other = await world("MgrOther");
    const mine = await world("MgrMine");
    const { p, seen } = provider(() =>
      good({
        OnboardingPlan: other.plan.id,
        OnboardingStep: other.step.id,
        UsageDaily: other.usage.id,
      }),
    );
    const out = await runAgent(
      mine.actor,
      onboardingManager,
      { planId: other.plan.id, reason: "stalled" },
      { type: "onboarding.stalled", id: "cross" },
      { provider: p },
    );
    expect(out).toMatchObject({ kind: "run", status: "UNCITED" });
    expect(seen[0]).not.toContain(other.plan.id);
    expect(seen[0]).not.toContain("Pinecrest");
    expect(await other.db.approval.count()).toBe(0);
  });
});
