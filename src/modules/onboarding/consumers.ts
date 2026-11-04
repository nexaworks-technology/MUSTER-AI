import { z } from "zod";
import { businessClock, calendarDateOf, daysBetween, todayIn, utcMidnight } from "@/lib/dates";
import { scopedDb, type ScopedDb, type TenantContext } from "@/lib/db/scoped";
import { listActiveWorkspaces } from "@/lib/db/workspace";
import { formatCalendarDate } from "@/lib/format";
import { logger } from "@/lib/logger";
import { loadContext } from "@/modules/health/service";
import {
  adoptionCoach,
  onboardingManager,
  runAgent,
  type ExecutorDeps,
  type RunOutcome,
} from "@/modules/agents/service";

/**
 * Consumers of the onboarding outbox events (M6 B3) and the sweeps that start the two M6 agents.
 *
 * - `onboarding.stalled` → the owner is told in the app (the existing notification bell; no new
 *   channel), and the Onboarding Manager is asked for a check-in draft and, if needed, an
 *   escalation Task. Without AI configured the notice still goes out and no draft is made.
 * - `onboarding.valueReached` → the owner is told the account reached first value.
 * - the sweep: a customer step due today asks the Onboarding Manager once; an open adoption
 *   signal asks the Adoption Coach once. Each run is keyed by its trigger, so a repeat is a no-op.
 *
 * Nothing here sends to a customer or marks anything done: the agents' drafts wait in Approvals.
 */
export const onboardingEventPayload = z.object({
  workspaceId: z.string().min(1),
  accountId: z.string().min(1),
  planId: z.string().min(1),
  outboxEventId: z.string().min(1).optional(),
  reason: z.string().optional(),
  date: z.string().optional(),
});

/** The account's owner, else the first CS Leader, else an Admin. */
async function ownerOrLeader(db: ScopedDb, accountId: string): Promise<string | null> {
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: { ownerMembershipId: true },
  });
  if (account?.ownerMembershipId) return account.ownerMembershipId;
  for (const role of ["CS_LEADER", "ADMIN"] as const) {
    const m = await db.membership.findFirst({
      where: { role, status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (m) return m.id;
  }
  return null;
}

const NOTICE_WINDOW_MS = 24 * 3_600_000;

/** One bell notice per (member, kind, plan) in a day: a retried job tells nobody twice. */
async function notifyOnce(
  db: ScopedDb,
  n: {
    workspaceId: string;
    recipient: string;
    type: "ONBOARDING_STALLED" | "ONBOARDING_VALUE_REACHED";
    title: string;
    planId: string;
    accountId: string;
  },
): Promise<boolean> {
  const seen = await db.notification.findFirst({
    where: {
      recipientMembershipId: n.recipient,
      type: n.type,
      refId: n.planId,
      createdAt: { gte: new Date(Date.now() - NOTICE_WINDOW_MS) },
    },
    select: { id: true },
  });
  if (seen) return false;
  await db.notification.create({
    data: {
      workspaceId: n.workspaceId,
      recipientMembershipId: n.recipient,
      type: n.type,
      title: n.title.slice(0, 200),
      refType: "OnboardingPlan",
      refId: n.planId,
      accountId: n.accountId,
    },
  });
  return true;
}

export interface StalledOutcome {
  notified: boolean;
  agent: RunOutcome | { kind: "skipped"; why: string };
}

export async function onOnboardingStalled(
  raw: unknown,
  deps: ExecutorDeps = {},
): Promise<StalledOutcome> {
  const p = onboardingEventPayload.parse(raw);
  const ctx: TenantContext = { workspaceId: p.workspaceId };
  const db = scopedDb(ctx);
  const plan = await db.onboardingPlan.findUnique({
    where: { id: p.planId },
    include: { account: { select: { name: true } } },
  });
  // The plan may have moved on (completed, cancelled, unstalled) between the event and now.
  if (!plan || plan.status !== "STALLED")
    return { notified: false, agent: { kind: "skipped", why: "the plan is no longer stalled" } };
  const recipient = await ownerOrLeader(db, plan.accountId);
  const notified = recipient
    ? await notifyOnce(db, {
        workspaceId: p.workspaceId,
        recipient,
        type: "ONBOARDING_STALLED",
        title: `Onboarding stalled at ${plan.account.name}: ${plan.stallReason ?? "see the plan"}`,
        planId: plan.id,
        accountId: plan.accountId,
      })
    : false;
  const agent = await runAgent(
    ctx,
    onboardingManager,
    { planId: plan.id, reason: "stalled" },
    {
      type: "onboarding.stalled",
      id: p.outboxEventId ?? `${plan.id}:${plan.lastEvaluatedOn?.toISOString() ?? ""}`,
    },
    deps,
  );
  if (agent.kind === "not_configured")
    logger.info(
      { workspaceId: p.workspaceId },
      "onboarding check-in skipped: AI is not configured",
    );
  return { notified, agent };
}

export async function onOnboardingValueReached(raw: unknown): Promise<{ notified: boolean }> {
  const p = onboardingEventPayload.parse(raw);
  const db = scopedDb({ workspaceId: p.workspaceId });
  const plan = await db.onboardingPlan.findUnique({
    where: { id: p.planId },
    include: { account: { select: { name: true } } },
  });
  if (!plan || !plan.valueReachedAt) return { notified: false };
  const recipient = await ownerOrLeader(db, plan.accountId);
  if (!recipient) return { notified: false };
  const reached = calendarDateOf(plan.valueReachedAt);
  const dayCount = daysBetween(calendarDateOf(plan.startDate), reached);
  return {
    notified: await notifyOnce(db, {
      workspaceId: p.workspaceId,
      recipient,
      type: "ONBOARDING_VALUE_REACHED",
      title: `${plan.account.name} reached first value on ${formatCalendarDate(plan.valueReachedAt)} (day ${dayCount})`,
      planId: plan.id,
      accountId: plan.accountId,
    }),
  };
}

/** Signals that mean "this account is not using what it pays for". */
export const ADOPTION_RULE_KEYS = [
  "seats_unused",
  "key_feature_stopped",
  "power_user_quiet",
  "usage_drop_vs_normal",
  "onboarding_key_feature_unused",
  "onboarding_no_activity",
] as const;

const SWEEP_CAP = 20;

/**
 * One workspace: customer steps due today ask the Onboarding Manager once each; open adoption
 * signals ask the Adoption Coach once each. Stops early when AI is not configured.
 */
export async function sweepOnboardingAgents(ctx: TenantContext, deps: ExecutorDeps = {}) {
  const db = scopedDb(ctx);
  const asOf = todayIn((await loadContext(ctx)).timeZone, deps.clock ?? businessClock);
  const out = { stepsDue: 0, signals: 0 };

  const due = await db.onboardingStep.findMany({
    where: {
      doneAt: null,
      ownerSide: "CUSTOMER",
      dueDate: utcMidnight(asOf),
      plan: { is: { status: "ACTIVE" } },
    },
    select: { id: true, planId: true, plan: { select: { accountId: true } } },
    take: SWEEP_CAP,
  });
  // D10: Sweeps skip accounts that have an active published play run
  const activePlayRuns = await db.playRun.findMany({
    where: {
      status: { in: ["RUNNING", "WAITING"] },
    },
    select: { accountId: true },
  });
  const playAccounts = new Set(activePlayRuns.map((r) => r.accountId));

  const ranSteps = new Set(
    (
      await db.agentRun.findMany({
        where: {
          agentKey: onboardingManager.key,
          triggerType: "step-due",
          triggerId: { in: due.map((s) => s.id) },
        },
        select: { triggerId: true },
      })
    ).map((r) => r.triggerId),
  );
  for (const s of due) {
    if (ranSteps.has(s.id) || playAccounts.has(s.plan.accountId)) continue;
    const r = await runAgent(
      ctx,
      onboardingManager,
      { planId: s.planId, reason: "step_due" },
      { type: "step-due", id: s.id },
      deps,
    );
    if (r.kind === "not_configured") return out;
    out.stepsDue++;
  }

  const signals = await db.signal.findMany({
    where: {
      status: "OPEN",
      ruleKey: { in: [...ADOPTION_RULE_KEYS] },
      account: { is: { archivedAt: null, lifecycleStage: { not: "LOST" } } },
    },
    orderBy: { firstSeenAt: "desc" },
    select: { id: true, accountId: true },
    take: SWEEP_CAP,
  });
  const ranSignals = new Set(
    (
      await db.agentRun.findMany({
        where: {
          agentKey: adoptionCoach.key,
          triggerType: "signal",
          triggerId: { in: signals.map((s) => s.id) },
        },
        select: { triggerId: true },
      })
    ).map((r) => r.triggerId),
  );
  const seenAccounts = new Set<string>();
  for (const s of signals) {
    // One coaching run per account per sweep, however many signals it has open.
    if (ranSignals.has(s.id) || seenAccounts.has(s.accountId) || playAccounts.has(s.accountId)) continue;
    seenAccounts.add(s.accountId);
    const r = await runAgent(
      ctx,
      adoptionCoach,
      { accountId: s.accountId, reason: "signal" },
      { type: "signal", id: s.id },
      deps,
    );
    if (r.kind === "not_configured") return out;
    out.signals++;
  }
  return out;
}

export async function sweepAllOnboardingAgents() {
  const out: Record<string, { stepsDue: number; signals: number }> = {};
  for (const w of await listActiveWorkspaces())
    out[w.slug] = await sweepOnboardingAgents({ workspaceId: w.id });
  return out;
}
