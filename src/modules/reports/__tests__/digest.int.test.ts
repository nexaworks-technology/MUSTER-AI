import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AiProvider } from "@/lib/ai";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { ForbiddenError } from "@/lib/auth/permissions";
import { prepareRun, leaderReporter } from "@/modules/agents/service";
import type { StaffEmail } from "@/lib/email";
import {
  businessWeekStart,
  DIGEST_REPORTS,
  ensureWeeklySnapshots,
  getLatestDigest,
  runWeeklyDigest,
} from "../service";

/**
 * The weekly leader digest (M11 S7) on the recorded AI transport: the model answer is composed from
 * the very records the agent is given (the same rule as scripts/leader-digest.ts), then judged by the
 * real executor. Proves Rule 5 (AgentRun with inputs, prompt version, model), the digest link on the
 * snapshots, recipients (internal leaders of this workspace only), idempotency per business week,
 * the failure path (no AI text) and money never reaching what a recipient receives.
 */
const MONDAY = () => new Date("2026-11-02T12:00:00Z");
const WEDNESDAY = () => new Date("2026-11-04T12:00:00Z");
const NEXT_MONDAY = () => new Date("2026-11-09T12:00:00Z");
const TZ = "UTC";

async function member(ws: string, role: "CS_LEADER" | "CSM" | "VIEWER", label: string) {
  const user = await rawDb.user.create({
    data: { email: `${label}-${randomUUID().slice(0, 8)}@larkspur.test`, name: label },
  });
  const m = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, true)`;
    return tx.membership.create({
      data: {
        workspaceId: ws,
        userId: user.id,
        role,
        bookScope: role === "CS_LEADER" ? "ALL" : "OWN",
      },
    });
  });
  return { user, membership: m };
}

async function world(label: string) {
  const A = await createTestAdmin(label);
  const ws = A.actor.workspaceId;
  const leader = await member(ws, "CS_LEADER", "leader");
  const csm = await member(ws, "CSM", "csm");
  const db = scopedDb(A.actor);
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Northgate Freight",
      tier: "MID_TOUCH",
      arrMinor: 98_765_400n,
      arrCurrency: "USD",
      ownerMembershipId: csm.membership.id,
    },
  });
  await db.contact.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      name: "Dana Customer",
      email: "dana@northgate.test",
    },
  });
  return { A, ws, db, leader, csm, account, ctx: { workspaceId: ws, timezone: TZ } };
}
type World = Awaited<ReturnType<typeof world>>;

type Rec = { sourceType: string; sourceId: string; fields: Record<string, unknown> };

/** The recorded answer: one item per report, repeating figures and dates as the records state them. */
function composed(bundle: Rec[], tamper?: (text: string) => string) {
  const headers = bundle.filter((r) => !r.sourceId.includes("#"));
  const items = headers.map((h) => {
    const fig = bundle.find(
      (r) => r.sourceId.startsWith(`${h.sourceId}#`) && typeof r.fields.value === "number",
    );
    const cited = fig ? [h, fig] : [h];
    const base = fig
      ? `The ${String(h.fields.report)} report for ${String(h.fields.periodStart)} to ${String(h.fields.periodEnd)}: ${String(fig.fields.label)} is ${String(fig.fields.value)}.`
      : `The ${String(h.fields.report)} report covers ${String(h.fields.periodStart)} to ${String(h.fields.periodEnd)}.`;
    return {
      text: tamper ? tamper(base) : base,
      citations: cited.map((r) => ({ sourceType: r.sourceType, sourceId: r.sourceId })),
    };
  });
  return {
    reasoningSummary: "One short item per report.",
    confidence: 0.7,
    citations: items.flatMap((i) => i.citations),
    proposedActions: [],
    items,
  };
}

async function providerFor(
  w: World,
  clock: () => Date,
  tamper?: (text: string) => string,
): Promise<AiProvider> {
  const snaps = (await ensureWeeklySnapshots(w.ctx, clock))!;
  const prep = await prepareRun(w.ctx, leaderReporter, { snapshotIds: snaps.snapshotIds });
  const answer = composed(prep.built.bundle as Rec[], tamper);
  return {
    name: "recorded",
    async generateStructured<T>() {
      return {
        output: answer as T,
        stopReason: "end_turn",
        model: "recorded",
        requestId: null,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
  };
}

const failingProvider = (stopReason: string): AiProvider => ({
  name: "recorded",
  async generateStructured<T>() {
    return {
      output: null as T | null,
      stopReason,
      model: "recorded",
      requestId: null,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    };
  },
});

function capture() {
  const sent: StaffEmail[] = [];
  return { sent, sendEmail: async (m: StaffEmail) => void sent.push(m) };
}

describe("weekly digest: the run", () => {
  it("a SUCCEEDED run is an AgentRun with its inputs, prompt version and model; the snapshots point at it", async () => {
    const w = await world("DigRun");
    const email = capture();
    const provider = await providerFor(w, MONDAY);
    const result = await runWeeklyDigest(w.ctx, MONDAY, {
      executor: { provider },
      sendEmail: email.sendEmail,
    });
    expect(result.status).toBe("DELIVERED");
    const run = await w.db.agentRun.findUniqueOrThrow({ where: { id: result.runId! } });
    expect(run).toMatchObject({
      agentKey: "leader-reporter",
      status: "SUCCEEDED",
      promptName: "leader-reporter",
      promptVersion: "1.0.0",
      model: "recorded",
      triggerType: "weekly-digest",
      triggerId: "2026-11-02",
    });
    const snaps = await w.db.reportSnapshot.findMany({
      where: { trigger: "SCHEDULED" },
      orderBy: { reportKey: "asc" },
    });
    expect(snaps.map((s) => s.reportKey).sort()).toEqual([...DIGEST_REPORTS].sort());
    expect(snaps.every((s) => s.generatedByMembershipId === null)).toBe(true);
    expect(snaps.every((s) => s.digestAgentRunId === run.id)).toBe(true);
    const inputs = (run.inputRefs as Array<{ sourceType: string; sourceId: string }>).map(
      (r) => r.sourceId.split("#")[0],
    );
    for (const s of snaps) expect(inputs).toContain(s.id);
    expect(run.citations).toBeTruthy();
    // The week is the 7 days before Monday 2026-11-02.
    expect(snaps.every((s) => s.periodStart.toISOString().startsWith("2026-10-26"))).toBe(true);
    expect(snaps.every((s) => s.periodEnd.toISOString().startsWith("2026-11-01"))).toBe(true);
  });

  it("the agent is never given a money figure, though the stored snapshots hold money figures", async () => {
    const w = await world("DigMoney");
    const snaps = (await ensureWeeklySnapshots(w.ctx, MONDAY))!;
    const rows = await w.db.reportSnapshot.findMany({ where: { id: { in: snaps.snapshotIds } } });
    const moneyFigures = rows.flatMap((r) =>
      (r.data as { sections: Array<{ figures: Array<{ unit: string }> }> }).sections.flatMap((s) =>
        s.figures.filter((f) => f.unit === "money"),
      ),
    );
    expect(moneyFigures.length).toBeGreaterThan(0);
    const prep = await prepareRun(w.ctx, leaderReporter, { snapshotIds: snaps.snapshotIds });
    const bundleText = JSON.stringify(prep.built.bundle);
    expect(prep.built.bundle.every((r) => r.fields.unit !== "money")).toBe(true);
    expect(bundleText).not.toContain("987654");
    expect(bundleText).not.toContain("98,765");
  });
});

describe("weekly digest: delivery", () => {
  it("goes to this workspace's Admins and CS Leaders only: never a CSM, a customer contact or another workspace", async () => {
    const w = await world("DigWho");
    const other = await world("DigOther");
    const email = capture();
    const result = await runWeeklyDigest(w.ctx, MONDAY, {
      executor: { provider: await providerFor(w, MONDAY) },
      sendEmail: email.sendEmail,
    });
    expect(result).toMatchObject({ status: "DELIVERED", notified: 2, emailed: 2, slackSent: 0 });
    const notes = await w.db.notification.findMany({ where: { type: "LEADER_DIGEST" } });
    expect(notes.map((n) => n.recipientMembershipId).sort()).toEqual(
      [w.A.actor.membershipId, w.leader.membership.id].sort(),
    );
    expect(notes.every((n) => n.channel === "IN_APP" && n.refType === "ReportDigest")).toBe(true);
    expect(notes.every((n) => n.refId === result.runId)).toBe(true);
    expect(email.sent.map((m) => m.to).sort()).toEqual(
      [w.A.actor.user.email, w.leader.user.email].sort(),
    );
    expect(email.sent.some((m) => /northgate|dana@|csm-/i.test(m.to))).toBe(false);
    // The other workspace has nothing: no notification, no run, no snapshot.
    const o = scopedDb(other.A.actor);
    expect(await o.notification.count()).toBe(0);
    expect(await o.agentRun.count({ where: { agentKey: "leader-reporter" } })).toBe(0);
    expect(await o.reportSnapshot.count()).toBe(0);
  });

  it("what a recipient receives carries no money, whatever their revenue access, and links to the digest", async () => {
    const w = await world("DigNoMoney");
    const email = capture();
    await runWeeklyDigest(w.ctx, MONDAY, {
      executor: { provider: await providerFor(w, MONDAY) },
      sendEmail: email.sendEmail,
    });
    expect(email.sent).toHaveLength(2);
    for (const m of email.sent) {
      const all = `${m.subject}\n${m.text}`;
      expect(all).not.toMatch(/[$€£]/);
      expect(all).not.toMatch(/987[,.]?654|98[,.]?765/);
      expect(all).toContain("/reports/digest");
      expect(all).toContain("Sources:");
    }
    const notes = await w.db.notification.findMany({ where: { type: "LEADER_DIGEST" } });
    for (const n of notes) expect(n.title).not.toMatch(/[$€£]|\d{3},\d{3}/);
  });

  it("is idempotent within a business week: the same or a later day does nothing again", async () => {
    const w = await world("DigIdem");
    const email = capture();
    const deps = {
      executor: { provider: await providerFor(w, MONDAY) },
      sendEmail: email.sendEmail,
    };
    const first = await runWeeklyDigest(w.ctx, MONDAY, deps);
    const again = await runWeeklyDigest(w.ctx, MONDAY, deps);
    const later = await runWeeklyDigest(w.ctx, WEDNESDAY, deps);
    expect(first.status).toBe("DELIVERED");
    expect(again).toMatchObject({ status: "ALREADY_DELIVERED", notified: 0, emailed: 0 });
    expect(later).toMatchObject({ status: "ALREADY_DELIVERED", notified: 0, emailed: 0 });
    expect(later.runId).toBe(first.runId);
    expect(email.sent).toHaveLength(2);
    expect(await w.db.notification.count({ where: { type: "LEADER_DIGEST" } })).toBe(2);
    expect(await w.db.agentRun.count({ where: { agentKey: "leader-reporter" } })).toBe(1);
    expect(await w.db.reportSnapshot.count({ where: { trigger: "SCHEDULED" } })).toBe(4);
  });

  it("the next business week is a new digest", async () => {
    const w = await world("DigNext");
    const email = capture();
    const a = await runWeeklyDigest(w.ctx, MONDAY, {
      executor: { provider: await providerFor(w, MONDAY) },
      sendEmail: email.sendEmail,
    });
    const b = await runWeeklyDigest(w.ctx, NEXT_MONDAY, {
      executor: { provider: await providerFor(w, NEXT_MONDAY) },
      sendEmail: email.sendEmail,
    });
    expect(b.status).toBe("DELIVERED");
    expect(b.runId).not.toBe(a.runId);
    expect(b.weekStart).toBe("2026-11-09");
    expect(email.sent).toHaveLength(4);
  });

  it("without leaders there is nobody to tell: nothing runs", async () => {
    const { actor } = await createTestAdmin("DigNone");
    await rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${actor.workspaceId}, true)`;
      await tx.membership.updateMany({
        where: { workspaceId: actor.workspaceId },
        data: { role: "VIEWER" },
      });
    });
    const r = await runWeeklyDigest({ workspaceId: actor.workspaceId, timezone: TZ }, MONDAY, {
      executor: { provider: failingProvider("end_turn") },
    });
    expect(r.status).toBe("NO_RECIPIENTS");
  });
});

describe("weekly digest: when it cannot be written", () => {
  it("a refusal delivers no AI text: each leader gets the honest notice linking to the reports", async () => {
    const w = await world("DigRefuse");
    const email = capture();
    const r = await runWeeklyDigest(w.ctx, MONDAY, {
      executor: { provider: failingProvider("refusal") },
      sendEmail: email.sendEmail,
    });
    expect(r.status).toBe("NOT_WRITTEN");
    expect(email.sent).toHaveLength(0);
    expect(await w.db.notification.count({ where: { type: "LEADER_DIGEST" } })).toBe(0);
    const notices = await w.db.notification.findMany({ where: { type: "LEADER_DIGEST_FAILED" } });
    expect(notices).toHaveLength(2);
    expect(notices.every((n) => n.refType === "ReportDigestNotice")).toBe(true);
    expect(notices[0]!.title).toBe(
      "This week's digest could not be written; the reports are ready.",
    );
    // The run says why; it is never rendered; the snapshots are not linked to it.
    const run = await w.db.agentRun.findUniqueOrThrow({ where: { id: r.runId! } });
    expect(run.status).toBe("FAILED");
    expect(await w.db.reportSnapshot.count({ where: { digestAgentRunId: { not: null } } })).toBe(0);
    expect(await getLatestDigest(w.A.actor)).toBeNull();
    // The reports themselves are ready.
    expect(await w.db.reportSnapshot.count({ where: { trigger: "SCHEDULED" } })).toBe(4);
    // A second pass the same week does not repeat the notice.
    await runWeeklyDigest(w.ctx, WEDNESDAY, {
      executor: { provider: failingProvider("refusal") },
      sendEmail: email.sendEmail,
    });
    expect(await w.db.notification.count({ where: { type: "LEADER_DIGEST_FAILED" } })).toBe(2);
  });

  it("a digest with a number that is in no cited figure is UNCITED: nothing is delivered or shown", async () => {
    const w = await world("DigUncited");
    const email = capture();
    const provider = await providerFor(w, MONDAY, (t) => `${t} That is up 77 from the last week.`);
    const r = await runWeeklyDigest(w.ctx, MONDAY, {
      executor: { provider },
      sendEmail: email.sendEmail,
    });
    expect(r.status).toBe("NOT_WRITTEN");
    const run = await w.db.agentRun.findUniqueOrThrow({ where: { id: r.runId! } });
    expect(run.status).toBe("UNCITED");
    expect(run.output).toBeNull();
    expect(email.sent).toHaveLength(0);
    expect(await w.db.notification.count({ where: { type: "LEADER_DIGEST" } })).toBe(0);
    expect(await w.db.notification.count({ where: { type: "LEADER_DIGEST_FAILED" } })).toBe(2);
    expect(await getLatestDigest(w.A.actor)).toBeNull();
  });

  it("with AI not configured no run exists and the notice says so", async () => {
    const w = await world("DigNoAi");
    const r = await runWeeklyDigest(w.ctx, MONDAY, {
      executor: { provider: undefined },
      sendEmail: capture().sendEmail,
    });
    // Without a provider the executor falls back to the configured transport; in tests AI_PROVIDER is
    // not "recorded" and there is no key, so it reports not_configured.
    expect(r.status).toBe("NOT_WRITTEN");
    expect(r.runId).toBeNull();
    const n = await w.db.notification.findFirstOrThrow({ where: { type: "LEADER_DIGEST_FAILED" } });
    expect(n.title).toContain("AI is not configured");
  });
});

describe("weekly digest: reading it", () => {
  it("shows the items with links to the reports they cite; only for leaders with whole-workspace scope", async () => {
    const w = await world("DigRead");
    await runWeeklyDigest(w.ctx, MONDAY, {
      executor: { provider: await providerFor(w, MONDAY) },
      sendEmail: capture().sendEmail,
    });
    const d = (await getLatestDigest(w.A.actor))!;
    expect(d.run.status).toBe("SUCCEEDED");
    expect(d.weekStart).toBe("2026-11-02");
    expect(d.items).toHaveLength(4);
    for (const i of d.items) {
      expect(i.sources.length).toBeGreaterThan(0);
      expect(i.sources.every((s) => !s.missing && s.href?.startsWith("/reports/"))).toBe(true);
      expect(i.sources[0]!.href).toContain("?start=2026-10-26&end=2026-11-01");
    }
    const csm = {
      workspaceId: w.ws,
      userId: w.csm.user.id,
      membershipId: w.csm.membership.id,
      role: "CSM" as const,
      canViewRevenue: false,
      bookScope: "OWN" as const,
    };
    await expect(getLatestDigest(csm)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("businessWeekStart is the Monday of the week", () => {
    expect(businessWeekStart("2026-11-02")).toBe("2026-11-02");
    expect(businessWeekStart("2026-11-08")).toBe("2026-11-02");
    expect(businessWeekStart("2026-11-09")).toBe("2026-11-09");
  });
});
