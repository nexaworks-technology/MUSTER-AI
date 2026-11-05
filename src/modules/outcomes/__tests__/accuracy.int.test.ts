import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { countQueries } from "@/test/query-counter";
import { killRule, loadAccuracy, tuneRule } from "../accuracy.service";

/**
 * M11 S5: the accuracy view on the database. Tenant isolation, book scope, a fixed query count,
 * no health-snapshot reads, and Tune/Kill as audited, permission-checked uses of updateRuleSettings.
 */
const NOW = new Date("2026-11-05T12:00:00Z");
const clock = () => NOW;
const DAY = 86_400_000;

async function workspace(label: string) {
  const { actor } = await createTestAdmin(label);
  return { actor: actor as Actor, ws: actor.workspaceId };
}
type Setup = Awaited<ReturnType<typeof workspace>>;

async function member(s: Setup, role: "CSM" | "CS_LEADER", scope: "OWN" | "ALL" = "OWN") {
  const user = await rawDb.user.create({
    data: { email: `${role}-${randomUUID().slice(0, 8)}@example.test`, name: role },
  });
  const m = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${s.ws}, true)`;
    return tx.membership.create({
      data: { workspaceId: s.ws, userId: user.id, role, bookScope: scope },
    });
  });
  return {
    ...s.actor,
    userId: user.id,
    membershipId: m.id,
    role,
    canViewRevenue: false,
    bookScope: scope,
  } as Actor;
}

async function flag(
  s: Setup,
  o: {
    ruleKey?: string;
    owner?: string | null;
    status?: "OPEN" | "FALSE_ALARM";
    churned?: boolean;
    agentKey?: string;
    accountId?: string;
  } = {},
) {
  const db = scopedDb(s.actor);
  const accountId =
    o.accountId ??
    (
      await db.account.create({
        data: {
          workspaceId: s.ws,
          name: `A ${randomUUID().slice(0, 6)}`,
          tier: "MID_TOUCH",
          ownerMembershipId: o.owner ?? null,
        },
      })
    ).id;
  // 90-day check date 10 days ago: inside the default window (D-167 judges by check date).
  const flaggedAt = new Date(NOW.getTime() - 100 * DAY);
  const signal = await db.signal.create({
    data: {
      workspaceId: s.ws,
      accountId,
      ruleKey: o.ruleKey ?? "usage_drop_vs_normal",
      ruleVersion: 1,
      category: "USAGE",
      severity: "WARN",
      polarity: "RISK",
      status: o.status ?? "OPEN",
      title: "t",
      explanation: "e",
      evidence: [{ sourceType: "Account", sourceId: accountId }],
      values: {},
      params: {},
      dedupeKey: `d:${randomUUID()}`,
      firstSeenAt: flaggedAt,
      lastSeenAt: flaggedAt,
    },
  });
  const run = o.agentKey ? await agentRun(s, o.agentKey) : null;
  await db.outcomeRecord.create({
    data: {
      workspaceId: s.ws,
      accountId,
      signalId: signal.id,
      agentRunId: run?.id ?? null,
      flagType: "RISK",
      flaggedAt,
      isTrueAlarm: o.churned ? true : null,
    },
  });
  return accountId;
}

const agentRun = (s: Setup, agentKey: string) =>
  scopedDb(s.actor).agentRun.create({
    data: {
      workspaceId: s.ws,
      agentKey,
      agentVersion: "1.0.0",
      promptName: agentKey,
      modelTier: "standard",
      triggerType: "test",
      triggerId: "t",
      idempotencyKey: `k-${randomUUID()}`,
    },
  });

async function decide(
  s: Setup,
  accountId: string,
  agentKey: string,
  status: "APPROVED" | "REJECTED" | "EXPIRED",
) {
  const run = await agentRun(s, agentKey);
  await scopedDb(s.actor).approval.create({
    data: {
      workspaceId: s.ws,
      accountId,
      kind: "SEND_EMAIL",
      reason: "r",
      proof: [{ sourceType: "Account", sourceId: accountId }],
      requiredLevel: "DRAFT_FOR_APPROVAL",
      proposedByAgentRunId: run.id,
      status,
      ...(status === "EXPIRED"
        ? {}
        : { decidedById: s.actor.membershipId, decidedAt: NOW, decidedVia: "APP" as const }),
    },
  });
}

describe("loadAccuracy (database)", () => {
  let a: Setup;
  let b: Setup;
  let csm: Actor;
  let ownAccount: string;

  beforeAll(async () => {
    a = await workspace("AccA");
    b = await workspace("AccB");
    csm = await member(a, "CSM");
    ownAccount = await flag(a, {
      owner: csm.membershipId,
      status: "FALSE_ALARM",
      agentKey: "wolf",
    });
    await flag(a, { churned: true, agentKey: "wolf" });
    await flag(a, { status: "FALSE_ALARM", ruleKey: "invoice_late" });
    await decide(a, ownAccount, "wolf", "APPROVED");
    await decide(a, ownAccount, "wolf", "REJECTED");
    await decide(a, ownAccount, "wolf", "EXPIRED");
    await flag(b, { status: "FALSE_ALARM", ruleKey: "tenant_b_only", agentKey: "b-agent" });
  });

  it("counts per rule and per agent, with acceptance, and never shows another workspace", async () => {
    const v = await loadAccuracy(a.actor, {}, clock);
    const rule = (k: string) => v.byRule.find((r) => r.key === k);
    expect(rule("usage_drop_vs_normal")).toMatchObject({ trueAlarms: 1, falseAlarms: 1 });
    expect(rule("invoice_late")).toMatchObject({ trueAlarms: 0, falseAlarms: 1 });
    expect(v.byAgent.find((r) => r.key === "wolf")).toMatchObject({
      trueAlarms: 1,
      falseAlarms: 1,
      approved: 1,
      rejected: 1,
      acceptanceRate: 0.5,
    });
    expect(v.byRule.some((r) => r.key === "tenant_b_only")).toBe(false);
    expect(v.byAgent.some((r) => r.key === "b-agent")).toBe(false);
    const vb = await loadAccuracy(b.actor, {}, clock);
    expect(vb.byRule.map((r) => r.key)).toEqual(["tenant_b_only"]);
  });

  it("a CSM with an own-book scope sees only their accounts", async () => {
    const v = await loadAccuracy(csm, {}, clock);
    expect(v.byRule.map((r) => r.key)).toEqual(["usage_drop_vs_normal"]);
    expect(v.byRule[0]).toMatchObject({ trueAlarms: 0, falseAlarms: 1 });
    expect(v.byAgent.find((r) => r.key === "wolf")).toMatchObject({ approved: 1, rejected: 1 });
  });

  it("flags outside the window are left out", async () => {
    const v = await loadAccuracy(a.actor, { windowDays: 5 }, clock);
    expect(v.byRule).toEqual([]);
  });

  it("uses a fixed number of queries and never reads a health snapshot", async () => {
    const small = await workspace("AccQ2");
    for (let i = 0; i < 2; i++) await flag(small, { status: "FALSE_ALARM", agentKey: "q" });
    const big = await workspace("AccQ5");
    for (let i = 0; i < 5; i++) await flag(big, { status: "FALSE_ALARM", agentKey: "q" });
    const s = await countQueries(() => loadAccuracy(small.actor, {}, clock));
    const l = await countQueries(() => loadAccuracy(big.actor, {}, clock));
    expect(l.queries).toBe(s.queries);
    expect([...s.statements, ...l.statements].some((q) => /health.?score.?snapshot/i.test(q))).toBe(
      false,
    );
  });
});

describe("Tune and Kill", () => {
  let s: Setup;
  let leader: Actor;
  let csm: Actor;

  beforeAll(async () => {
    s = await workspace("AccTune");
    leader = await member(s, "CS_LEADER", "ALL");
    csm = await member(s, "CSM");
    await rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${s.ws}, true)`;
    });
    const { syncSignalRules } = await import("@/modules/signals/service");
    await syncSignalRules(s.actor);
  });

  it("Tune writes signal_rule.updated with before and after", async () => {
    const r = await tuneRule(leader, "invoice_late", { graceDays: 14, materialDays: 30 });
    expect(r).toMatchObject({ version: 2, params: { graceDays: 14 } });
    const audit = await scopedDb(s.actor).auditLog.findFirstOrThrow({
      where: { action: "signal_rule.updated", targetId: r.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.before).toMatchObject({ params: { graceDays: 7 } });
    expect(audit.after).toMatchObject({ params: { graceDays: 14 } });
  });

  it("Kill switches the rule off and audits it", async () => {
    const r = await killRule(leader, "usage_drop_vs_normal");
    expect(r.enabled).toBe(false);
    const audit = await scopedDb(s.actor).auditLog.findFirstOrThrow({
      where: { action: "signal_rule.updated", targetId: r.id },
    });
    expect(audit.before).toMatchObject({ enabled: true });
    expect(audit.after).toMatchObject({ enabled: false });
  });

  it("a CSM without healthModel:propose is refused, and nothing changes", async () => {
    await expect(killRule(csm, "invoice_late")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(tuneRule(csm, "invoice_late", { graceDays: 3 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const row = await scopedDb(s.actor).signalRule.findFirstOrThrow({
      where: { ruleKey: "invoice_late" },
    });
    expect(row.enabled).toBe(true);
    expect(row.params).toMatchObject({ graceDays: 14 });
  });
});
