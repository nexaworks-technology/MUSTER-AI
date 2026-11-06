import { beforeAll, describe, expect, it } from "vitest";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import { addDays, businessClock, todayIn, utcMidnight } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { adoptionCoach } from "../definitions/adoption-coach";
import { runAgent } from "../executor";
import { renderableRun } from "../service";

/**
 * M6 §5 Adoption Coach: the unused-value finding cites FeatureCatalog and FeatureUsageDaily rows;
 * an id outside the bundle is UNCITED and nothing renders; counts come from adoption.ts and the
 * model's own are overwritten; the nudge lands in Approvals and nothing is sent.
 */
type World = Awaited<ReturnType<typeof world>>;
const TODAY = todayIn("UTC", businessClock);
const ago = (n: number) => utcMidnight(addDays(TODAY, -n));
const FEATURES = [
  ["dashboards", "Dashboards", true],
  ["scheduled_reports", "Scheduled reports", true],
  ["alerts", "Alerts", false],
  ["csv_export", "CSV export", false],
  ["data_connectors", "Data connectors", true],
] as const;

async function world(label: string, usedKeys: readonly string[] = ["dashboards", "alerts"]) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const account = await db.account.create({
    data: { workspaceId: ws, name: "Pinecrest Health", tier: "MID_TOUCH", plan: "Growth" },
  });
  await db.contract.create({
    data: { workspaceId: ws, accountId: account.id, startDate: ago(60), seatsPurchased: 10 },
  });
  const contact = await db.contact.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      name: "Raj Menon",
      email: "raj@pinecrest-health.test",
    },
  });
  const catalog = [];
  for (const [featureKey, name, isKeyFeature] of FEATURES)
    catalog.push(
      await db.featureCatalog.create({
        data: {
          workspaceId: ws,
          featureKey,
          label: name,
          isKeyFeature,
          includedInPlans: ["Growth"],
        },
      }),
    );
  const usage = await db.usageDaily.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      date: ago(1),
      activeUsers: 2,
      sessions: 3,
      events: 9,
    },
  });
  const featureRows = [];
  for (const key of usedKeys)
    featureRows.push(
      await db.featureUsageDaily.create({
        data: {
          workspaceId: ws,
          accountId: account.id,
          featureKey: key,
          date: ago(2),
          users: 2,
          events: 5,
        },
      }),
    );
  return { actor, db, account, contact, catalog, usage, featureRows };
}

function provider(output: (w: World) => unknown, w: World) {
  const seen: string[] = [];
  const p: AiProvider = {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      seen.push(req.input);
      return {
        output: output(w) as T,
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

const unused = (w: World) =>
  w.catalog.filter((c) =>
    ["scheduled_reports", "csv_export", "data_connectors"].includes(c.featureKey),
  );
const good = (w: World, over: Record<string, unknown> = {}) => {
  const reports = w.catalog.find((c) => c.featureKey === "scheduled_reports")!;
  return {
    reasoningSummary: "Scheduled reports are a key feature in their plan that no one has used.",
    confidence: 0.7,
    citations: [
      { sourceType: "Account", sourceId: w.account.id },
      { sourceType: "FeatureCatalog", sourceId: reports.id },
    ],
    proposedActions: [],
    findings: [
      {
        text: "3 of 5 features in the Growth plan have never been used, including Scheduled reports.",
        citesCatalogIds: unused(w).map((c) => c.id),
        citesUsageIds: [w.featureRows[0]!.id],
      },
    ],
    subject: "Getting more from Scheduled reports",
    body: "Hi Raj,\n\n3 of 5 features in your Growth plan haven't been tried yet, and Scheduled reports could save your team time. Want me to walk you through setting one up?\n\nAisha",
    ...over,
  };
};

const run = (w: World, p: AiProvider, id = "sig1") =>
  runAgent(
    w.actor,
    adoptionCoach,
    { accountId: w.account.id, reason: "signal" },
    { type: "signal", id },
    { provider: p },
  );

let W: World;
beforeAll(async () => {
  W = await world("CoachA");
});

describe("Adoption Coach (M6 §5)", () => {
  it("validates, cites feature records, and drafts the nudge into Approvals; nothing is sent", async () => {
    const { p, seen } = provider(good, W);
    const out = await run(W, p);
    expect(out).toMatchObject({ kind: "run", status: "SUCCEEDED" });
    // The counts the model may repeat come from adoption.ts, on the account record.
    expect(seen[0]).toContain('"featuresNeverUsed": 3');
    expect(seen[0]).toContain('"featuresInPlan": 5');
    const r = await W.db.agentRun.findFirstOrThrow({ where: { agentKey: "adoption-coach" } });
    expect(r).toMatchObject({
      actionTaken: "APPROVAL_REQUESTED",
      promptVersion: "1.0.0",
      status: "SUCCEEDED",
    });
    const approval = await W.db.approval.findFirstOrThrow({
      where: { proposedByAgentRunId: r.id },
    });
    expect(approval).toMatchObject({
      kind: "SEND_EMAIL",
      status: "PENDING",
      requiredLevel: "DRAFT_FOR_APPROVAL",
    });
    const proof = JSON.stringify(approval.proof);
    expect(proof).toContain("FeatureCatalog");
    expect(proof).toContain(W.featureRows[0]!.id);
    const message = await W.db.outboundMessage.findFirstOrThrow({
      where: { approvalId: approval.id },
    });
    expect(message).toMatchObject({
      status: "AWAITING_APPROVAL",
      toEmail: "raj@pinecrest-health.test",
      origin: "AI",
    });
    expect(message.sentAt).toBeNull();
  });

  it("the finding is renderable only as a SUCCEEDED run, with its citations", async () => {
    const r = await W.db.agentRun.findFirstOrThrow({ where: { agentKey: "adoption-coach" } });
    const shown = await renderableRun(W.actor, r.id);
    expect(shown).not.toBeNull();
    const out = shown!.output as { findings: Array<{ citesCatalogIds: string[] }> };
    expect(out.findings[0]!.citesCatalogIds).toHaveLength(3);
  });

  it("an id outside the bundle is UNCITED and nothing is rendered or drafted", async () => {
    const w = await world("CoachCite");
    const out = await run(
      w,
      provider(
        (x) =>
          good(x, {
            findings: [
              {
                text: "Scheduled reports are unused.",
                citesCatalogIds: ["feature_not_given"],
                citesUsageIds: [],
              },
            ],
          }),
        w,
      ).p,
    );
    expect(out).toMatchObject({ status: "UNCITED" });
    if (out.kind !== "run") throw new Error("unreachable");
    expect(await renderableRun(w.actor, out.runId)).toBeNull();
    expect(await w.db.approval.count()).toBe(0);
  });

  it("a finding that cites nothing is UNCITED", async () => {
    const w = await world("CoachNoCite");
    const out = await run(
      w,
      provider(
        (x) =>
          good(x, {
            findings: [
              { text: "They are not using much.", citesCatalogIds: [], citesUsageIds: [] },
            ],
          }),
        w,
      ).p,
    );
    expect(out).toMatchObject({ status: "UNCITED" });
  });

  it("a number the model invents is UNCITED", async () => {
    const w = await world("CoachNum");
    const out = await run(
      w,
      // M12 (founder-approved): figures no bundle value can hold (counts ≤ 5, days ≤ 31); "4 of 5"
      // coincided with real-date fields like "Nov 4, 2026" on some days.
      provider((x) => good(x, { body: "Hi Raj, 37 of 41 features are unused. Want help?" }), w).p,
    );
    expect(out).toMatchObject({ status: "UNCITED" });
    expect(await w.db.approval.count()).toBe(0);
  });

  it("overwrites a model-supplied count with the adoption figure and drops the rest", async () => {
    const w = await world("CoachFacts");
    const out = await run(
      w,
      provider(
        (x) =>
          good(x, {
            proposedActions: [
              { type: "NUDGE", summary: "Show reports", count: 9, percent: 90, confidence: 0.2 },
            ],
          }),
        w,
      ).p,
    );
    expect(out).toMatchObject({ status: "SUCCEEDED" });
    const r = await w.db.agentRun.findFirstOrThrow();
    const action = (r.output as { proposedActions: Array<Record<string, unknown>> })
      .proposedActions[0]!;
    expect(action.count).toBe(3);
    for (const f of ["percent", "confidence"]) expect(action).not.toHaveProperty(f);
  });

  it("when every feature is used there is nothing to say, and nothing is drafted", async () => {
    const w = await world(
      "CoachAll",
      FEATURES.map((f) => f[0]),
    );
    const out = await run(
      w,
      provider(
        (x) => ({
          reasoningSummary: "Every plan feature has been used.",
          confidence: 0.9,
          citations: [{ sourceType: "Account", sourceId: x.account.id }],
          proposedActions: [],
          findings: [],
          subject: null,
          body: null,
          insufficientData: { missing: ["No unused feature to raise"] },
        }),
        w,
      ).p,
    );
    expect(out).toMatchObject({ status: "SUCCEEDED" });
    expect(await w.db.approval.count()).toBe(0);
    expect((await w.db.agentRun.findFirstOrThrow()).actionTaken).toBe("NONE");
  });

  it("another workspace's account is unreachable", async () => {
    const other = await world("CoachOther");
    const mine = await world("CoachMine");
    const { p, seen } = provider(() => good(other), other);
    const out = await runAgent(
      mine.actor,
      adoptionCoach,
      { accountId: other.account.id, reason: "signal" },
      { type: "signal", id: "cross" },
      { provider: p },
    );
    expect(out).toMatchObject({ status: "UNCITED" });
    expect(seen[0]).not.toContain(other.account.id);
    expect(await other.db.approval.count()).toBe(0);
  });
});
