import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import { addDays, businessClock, todayIn, utcMidnight } from "@/lib/dates";
import { AWAITING_CONSUMER, OUTBOX_ROUTES } from "@/lib/jobs/outbox";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { PROCESSORS } from "@/worker/processors";
import { createTestAdmin } from "@/test/fixtures";
import { onOnboardingStalled, onOnboardingValueReached, sweepOnboardingAgents } from "../consumers";

/**
 * M6 B3: the consumers of onboarding.stalled / onboarding.valueReached (owner notice through the
 * existing bell, then the Onboarding Manager) and the sweep that starts the agents. Fake provider
 * only; nothing here sends to a customer.
 */
const TODAY = todayIn("UTC", businessClock);
const ago = (n: number) => utcMidnight(addDays(TODAY, -n));

async function world(label: string, status: "STALLED" | "ACTIVE" | "COMPLETE" = "STALLED") {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const user = await rawDb.user.create({
    data: {
      email: `${label.toLowerCase()}-${randomUUID().slice(0, 8)}@t.test`,
      name: "Aisha Bello",
    },
  });
  const csm = await db.membership.create({
    data: { workspaceId: ws, userId: user.id, role: "CSM" },
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
  const contact = await db.contact.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      name: "Raj Menon",
      email: "raj@pinecrest-health.test",
    },
  });
  const plan = await db.onboardingPlan.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      startDate: ago(34),
      targetValueDate: ago(-5),
      status,
      stallReason: status === "STALLED" ? "SSO setup (customer) overdue 12 days" : null,
      valueReachedAt: status === "COMPLETE" ? ago(2) : null,
      valueEvidence:
        status === "COMPLETE"
          ? [{ sourceType: "UsageDaily", sourceId: "x", value: 3, date: "d" }]
          : [],
      blockers:
        status === "STALLED"
          ? [
              {
                kind: "STEP_OVERDUE_CUSTOMER",
                text: "SSO setup (customer) overdue 12 days",
                days: 12,
                sources: [],
              },
            ]
          : [],
    },
  });
  const step = await db.onboardingStep.create({
    data: {
      workspaceId: ws,
      planId: plan.id,
      key: "sso",
      position: 1,
      title: "SSO setup",
      ownerSide: "CUSTOMER",
      ownerContactId: contact.id,
      dueDate: status === "ACTIVE" ? ago(0) : ago(12),
    },
  });
  return { actor, db, csm, account, contact, plan, step };
}

function provider() {
  let calls = 0;
  const p: AiProvider = {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      calls++;
      const ids: Record<string, string> = {};
      for (const m of req.input.matchAll(/"sourceType": "([^"]+)",\s+"sourceId": "([^"]+)"/g))
        ids[m[1]!] ??= m[2]!;
      const adoption = req.promptRef.startsWith("adoption-coach");
      const output = adoption
        ? {
            reasoningSummary: "Nothing to raise.",
            confidence: 0.5,
            citations: [{ sourceType: "Account", sourceId: ids.Account }],
            proposedActions: [],
            findings: [],
            subject: null,
            body: null,
          }
        : {
            reasoningSummary: "The customer's SSO step is overdue.",
            confidence: 0.7,
            citations: [
              { sourceType: "OnboardingPlan", sourceId: ids.OnboardingPlan },
              { sourceType: "OnboardingStep", sourceId: ids.OnboardingStep },
            ],
            proposedActions: [],
            subject: "Getting SSO set up",
            body: "Hi Raj,\n\nIs something in the way of the SSO setup? I can join a short call.\n\nAisha",
            escalation: { needed: false, note: null },
          };
      return {
        output: output as T,
        stopReason: "end_turn",
        model: "model-from-env-standard",
        requestId: null,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
  };
  return { p, calls: () => calls };
}

const payload = (w: Awaited<ReturnType<typeof world>>, extra: object = {}) => ({
  workspaceId: w.actor.workspaceId,
  accountId: w.account.id,
  planId: w.plan.id,
  outboxEventId: randomUUID(),
  ...extra,
});

describe("onboarding.stalled consumer", () => {
  it("is routed to the agents queue and no longer waits for a consumer", () => {
    expect(OUTBOX_ROUTES["onboarding.stalled"]).toEqual({
      queue: "agents",
      job: "onboarding.stalled",
    });
    expect(OUTBOX_ROUTES["onboarding.valueReached"]).toEqual({
      queue: "agents",
      job: "onboarding.valueReached",
    });
    expect(AWAITING_CONSUMER).not.toContain("onboarding.stalled");
    expect(AWAITING_CONSUMER).not.toContain("onboarding.valueReached");
    expect(PROCESSORS.agents?.["onboarding.stalled"]).toBeTypeOf("function");
    expect(PROCESSORS.agents?.["onboarding.valueReached"]).toBeTypeOf("function");
  });

  it("tells the owner in the bell once, and asks the Onboarding Manager for a draft in Approvals", async () => {
    const w = await world("ConsStall");
    const { p } = provider();
    const body = payload(w);
    const first = await onOnboardingStalled(body, { provider: p });
    expect(first.notified).toBe(true);
    expect(first.agent).toMatchObject({ kind: "run", status: "SUCCEEDED" });
    const notes = await w.db.notification.findMany({ where: { type: "ONBOARDING_STALLED" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      recipientMembershipId: w.csm.id,
      refType: "OnboardingPlan",
      refId: w.plan.id,
      channel: "IN_APP",
    });
    expect(notes[0]!.title).toBe(
      "Onboarding stalled at Pinecrest Health: SSO setup (customer) overdue 12 days",
    );
    expect(await w.db.approval.count({ where: { status: "PENDING", kind: "SEND_EMAIL" } })).toBe(1);
    // A retried job (same event) notifies nobody twice and drafts nothing twice.
    const again = await onOnboardingStalled(body, { provider: p });
    expect(again.notified).toBe(false);
    expect(again.agent).toMatchObject({ kind: "run", reused: true });
    expect(await w.db.notification.count({ where: { type: "ONBOARDING_STALLED" } })).toBe(1);
    expect(await w.db.approval.count()).toBe(1);
    expect(
      await w.db.outboundMessage.count({ where: { status: { not: "AWAITING_APPROVAL" } } }),
    ).toBe(0);
  });

  it("without AI the owner is still told; no draft is made and nothing fails", async () => {
    const w = await world("ConsNoAi");
    const out = await onOnboardingStalled(payload(w));
    expect(out.notified).toBe(true);
    expect(out.agent).toMatchObject({ kind: "not_configured" });
    expect(await w.db.approval.count()).toBe(0);
    expect(await w.db.agentRun.count()).toBe(0);
  });

  it("an account with no owner goes to the first CS Leader", async () => {
    const w = await world("ConsLeader");
    await w.db.account.update({ where: { id: w.account.id }, data: { ownerMembershipId: null } });
    const leaderUser = await rawDb.user.create({
      data: { email: `leader-${randomUUID().slice(0, 8)}@t.test`, name: "Lena Lead" },
    });
    const leader = await w.db.membership.create({
      data: { workspaceId: w.actor.workspaceId, userId: leaderUser.id, role: "CS_LEADER" },
    });
    await onOnboardingStalled(payload(w));
    const note = await w.db.notification.findFirstOrThrow({
      where: { type: "ONBOARDING_STALLED" },
    });
    expect(note.recipientMembershipId).toBe(leader.id);
  });

  it("does nothing when the plan is no longer stalled, or belongs to another workspace", async () => {
    const done = await world("ConsDone", "COMPLETE");
    const { p, calls } = provider();
    expect(await onOnboardingStalled(payload(done), { provider: p })).toMatchObject({
      notified: false,
      agent: { kind: "skipped" },
    });
    const other = await world("ConsOther");
    const mine = await world("ConsMine");
    const cross = await onOnboardingStalled(
      { ...payload(other), workspaceId: mine.actor.workspaceId },
      { provider: p },
    );
    expect(cross.notified).toBe(false);
    expect(calls()).toBe(0);
    expect(await other.db.notification.count()).toBe(0);
    expect(await mine.db.notification.count()).toBe(0);
  });
});

describe("onboarding.valueReached consumer", () => {
  it("tells the owner once, with the day count from the plan", async () => {
    const w = await world("ConsValue", "COMPLETE");
    const body = payload(w);
    expect(await onOnboardingValueReached(body)).toEqual({ notified: true });
    expect(await onOnboardingValueReached(body)).toEqual({ notified: false });
    const note = await w.db.notification.findFirstOrThrow({
      where: { type: "ONBOARDING_VALUE_REACHED" },
    });
    expect(note.recipientMembershipId).toBe(w.csm.id);
    expect(note.title).toMatch(/^Pinecrest Health reached first value on .+ \(day 32\)$/);
  });

  it("says nothing for a plan that has not reached value", async () => {
    const w = await world("ConsNoValue");
    expect(await onOnboardingValueReached(payload(w))).toEqual({ notified: false });
  });
});

describe("the sweep", () => {
  it("a customer step due today asks the Onboarding Manager once; a second sweep adds nothing", async () => {
    const w = await world("SweepDue", "ACTIVE");
    const { p } = provider();
    const first = await sweepOnboardingAgents(w.actor, { provider: p });
    expect(first.stepsDue).toBe(1);
    const second = await sweepOnboardingAgents(w.actor, { provider: p });
    expect(second.stepsDue).toBe(0);
    expect(await w.db.agentRun.count({ where: { agentKey: "onboarding-manager" } })).toBe(1);
    expect(await w.db.approval.count({ where: { status: "PENDING" } })).toBe(1);
  });

  it("an open adoption signal asks the Adoption Coach once per account", async () => {
    const w = await world("SweepSignal", "ACTIVE");
    for (const key of ["seats_unused", "key_feature_stopped"])
      await w.db.signal.create({
        data: {
          workspaceId: w.actor.workspaceId,
          accountId: w.account.id,
          ruleKey: key,
          ruleVersion: 1,
          category: "USAGE",
          severity: "WARN",
          polarity: "RISK",
          title: key,
          explanation: key,
          evidence: [{ sourceType: "Account", sourceId: w.account.id }],
          values: {},
          params: {},
          dedupeKey: `${key}:${w.account.id}`,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        },
      });
    const { p } = provider();
    const out = await sweepOnboardingAgents(w.actor, { provider: p });
    expect(out.signals).toBe(1);
    expect(await w.db.agentRun.count({ where: { agentKey: "adoption-coach" } })).toBe(1);
  });

  it("stops quietly when AI is not configured", async () => {
    const w = await world("SweepNoAi", "ACTIVE");
    expect(await sweepOnboardingAgents(w.actor)).toEqual({ stepsDue: 0, signals: 0 });
    expect(await w.db.agentRun.count()).toBe(0);
  });
});
