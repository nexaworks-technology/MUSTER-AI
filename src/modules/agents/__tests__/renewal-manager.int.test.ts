import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import { businessClock, todayIn, utcMidnight, addDays } from "@/lib/dates";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { readDocument } from "@/modules/documents/service";
import { createTestAdmin } from "@/test/fixtures";
import { runAgent } from "../executor";
import { renewalManager } from "../definitions/renewal-manager";
import { renderableRun } from "../service";

/**
 * M7 B3 Renewal Manager (recorded provider): every number in its text is a placeholder that code
 * fills from locked metrics; the plan lands on a Renewal Brief document; the outreach is an Approval
 * with only the renewal date in it (never sent); the next step is an internal Task whose date code
 * computed; a digit or an unknown placeholder is INVALID_OUTPUT and writes nothing; the run records
 * what Rule 5 asks for; confidence / ARR / estimate in proposed actions are replaced by records.
 */
type World = Awaited<ReturnType<typeof world>>;
const TODAY = todayIn("UTC", businessClock);
const d = (n: number) => utcMidnight(addDays(TODAY, n));

async function world(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const csmUser = await rawDb.user.create({
    data: {
      email: `${label.toLowerCase()}-aisha-${randomUUID().slice(0, 8)}@t.test`,
      name: "Aisha Bello",
    },
  });
  const csm = await db.membership.create({
    data: { workspaceId: ws, userId: csmUser.id, role: "CSM" },
  });
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Northgate Freight",
      tier: "MID_TOUCH",
      plan: "Growth",
      ownerMembershipId: csm.id,
    },
  });
  const contact = await db.contact.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      name: "Sam Reyes",
      title: "Head of Operations",
      email: "sam@northgate.test",
    },
  });
  const contract = await db.contract.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      startDate: d(-324),
      endDate: d(41),
      renewalDate: d(41),
      noticePeriodDays: 30,
      valueMinor: 14_200_000n,
      seatsPurchased: 158,
    },
  });
  const renewal = await db.renewal.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      contractId: contract.id,
      renewalDate: d(41),
      noticeDeadline: d(11),
      arrAtRiskMinor: 14_200_000n,
      currency: "USD",
      confidence: 70,
      confidenceBand: "HIGH",
      confidenceReasons: [],
      confidenceAsOf: d(0),
    },
  });
  const signal = await db.signal.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      ruleKey: "ticket_open_too_long",
      ruleVersion: 1,
      category: "SUPPORT",
      severity: "WARN",
      polarity: "RISK",
      title: "Ticket open 9 days: Export fails for large files",
      explanation: "x",
      evidence: [{ sourceType: "Ticket", sourceId: "t1" }],
      values: {},
      params: {},
      dedupeKey: `ticket_open_too_long:${account.id}:t1`,
      firstSeenAt: d(-9),
      lastSeenAt: d(0),
    },
  });
  return { actor, db, ws, csm, account, contact, contract, renewal, signal };
}

function provider(output: (ids: Record<string, string>) => unknown) {
  const p: AiProvider = {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
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
  return p;
}

const good = (ids: Record<string, string>, over: Record<string, unknown> = {}) => ({
  reasoningSummary: "The renewal is near and an open ticket should be handled before the call.",
  confidence: 0.7,
  citations: [
    { sourceType: "Renewal", sourceId: ids.Renewal },
    { sourceType: "Signal", sourceId: ids.Signal },
  ],
  proposedActions: [],
  planSteps: [
    { title: "Resolve the open export ticket", detail: "Agree a fix date with support." },
    {
      title: "Hold the renewal call",
      detail: "Before the notice deadline on {{metric.renewal.noticeDeadline}}.",
    },
  ],
  talkTrack: [
    "Acknowledge the export ticket.",
    "Ask what would make {{metric.renewal.date}} an easy yes.",
  ],
  outreach: {
    subject: "Planning your renewal",
    body: "Hi Sam,\n\nYour renewal comes up on {{metric.renewal.date}}. Could we find time to talk?\n\nAisha",
  },
  nextStep: { action: "Confirm the renewal call", timing: "within_a_week" },
  ...over,
});

const run = (w: World, p: AiProvider, id = "sig1") =>
  runAgent(
    w.actor,
    renewalManager,
    { renewalId: w.renewal.id },
    { type: "signal", id },
    { provider: p },
  );

let W: World;
beforeAll(async () => {
  W = await world("RenMgr");
});

describe("Renewal Manager (M7 B3)", () => {
  it("writes a brief on locked metrics, an Approval for the outreach and a Task with a code-computed date", async () => {
    const out = await run(
      W,
      provider((ids) => good(ids)),
    );
    expect(out).toMatchObject({ kind: "run", status: "SUCCEEDED" });
    const r = await W.db.agentRun.findFirstOrThrow({ where: { agentKey: "renewal-manager" } });
    expect(r.actionTaken).toBe("APPROVAL_REQUESTED");

    // The brief: origin AI naming the run, metrics locked, narrative rendered from them.
    const doc = await W.db.document.findFirstOrThrow({ where: { agentRunId: r.id } });
    expect(doc).toMatchObject({ kind: "RENEWAL_BRIEF", origin: "AI" });
    expect(doc.lockedAt).not.toBeNull();
    expect(
      (await W.db.renewal.findUniqueOrThrow({ where: { id: W.renewal.id } })).briefDocumentId,
    ).toBe(doc.id);
    const view = await readDocument(W.actor, doc.id);
    const text = view.rendered.map((b) => b.text).join("\n");
    const dateText = view.metrics.find((m) => m.key === "renewal.date")!.text;
    expect(text).toContain(
      `Before the notice deadline on ${view.metrics.find((m) => m.key === "renewal.noticeDeadline")!.text}`,
    );
    expect(text).toContain(`Ask what would make ${dateText} an easy yes.`);
    expect(text).not.toContain("{{");
    const due = addDays(TODAY, 7);
    expect(text).toContain(`Next step: Confirm the renewal call, by ${due}.`);

    // The outreach: an Approval, nothing sent, only the renewal date filled in by code.
    const approval = await W.db.approval.findFirstOrThrow({
      where: { proposedByAgentRunId: r.id },
    });
    expect(approval).toMatchObject({
      kind: "SEND_EMAIL",
      status: "PENDING",
      requiredLevel: "DRAFT_FOR_APPROVAL",
    });
    const message = await W.db.outboundMessage.findFirstOrThrow({
      where: { approvalId: approval.id },
    });
    expect(message).toMatchObject({
      status: "AWAITING_APPROVAL",
      toEmail: "sam@northgate.test",
      origin: "AI",
      agentRunId: r.id,
    });
    expect(message.sentAt).toBeNull();
    expect(message.bodyText).toContain(`Your renewal comes up on ${dateText}.`);
    expect(message.bodyText).not.toMatch(/\{\{|142,000|70%/);

    // The next step: an internal Task, no approval (Q-65), dated by code.
    const task = await W.db.task.findFirstOrThrow({ where: { agentRunId: r.id } });
    expect(task).toMatchObject({
      title: `Confirm the renewal call — by ${due}`,
      ownerMembershipId: W.csm.id,
      origin: "AI",
      priority: "HIGH",
    });
    expect(task.dueAt!.toISOString().slice(0, 10)).toBe(due);
  });

  it("records what Rule 5 asks for: prompt version, model, inputs, output, reasoning, confidence, effects", async () => {
    const r = await W.db.agentRun.findFirstOrThrow({ where: { agentKey: "renewal-manager" } });
    expect(r).toMatchObject({
      promptName: "renewal-manager",
      promptVersion: "1.0.0",
      model: "model-from-env-standard",
      status: "SUCCEEDED",
    });
    expect(r.reasoningSummary).toBeTruthy();
    expect(r.confidence).not.toBeNull();
    expect(JSON.stringify(r.inputRefs)).toContain(W.renewal.id);
    expect(JSON.stringify(r.inputRefs)).toContain(W.signal.id);
    expect(r.output).not.toBeNull();
    expect(JSON.stringify(r.effects)).toMatch(/Document.*Approval|Approval.*Document/s);
  });

  it("a second run of the same trigger changes nothing", async () => {
    await run(
      W,
      provider((ids) => good(ids)),
    );
    expect(await W.db.document.count()).toBe(1);
    expect(await W.db.approval.count()).toBe(1);
    expect(await W.db.task.count()).toBe(1);
  });

  it("a digit in the text is INVALID_OUTPUT: nothing rendered, nothing written", async () => {
    const w = await world("RenMgrDigit");
    const out = await run(
      w,
      provider((ids) => good(ids, { talkTrack: ["About 142,000 is at stake."] })),
    );
    expect(out).toMatchObject({ kind: "run", status: "INVALID_OUTPUT" });
    if (out.kind !== "run") throw new Error("unreachable");
    expect(await renderableRun(w.actor, out.runId)).toBeNull();
    expect(await w.db.document.count()).toBe(0);
    expect(await w.db.approval.count()).toBe(0);
    expect(await w.db.task.count()).toBe(0);
  });

  it("an internal-only placeholder in the customer email is INVALID_OUTPUT", async () => {
    const w = await world("RenMgrLeak");
    const out = await run(
      w,
      provider((ids) =>
        good(ids, {
          outreach: { subject: "Renewal", body: "Hi Sam, your health is {{metric.health.band}}." },
        }),
      ),
    );
    expect(out).toMatchObject({ status: "INVALID_OUTPUT" });
    expect(await w.db.outboundMessage.count()).toBe(0);
  });

  it("a citation outside the run's records is UNCITED and writes nothing", async () => {
    const w = await world("RenMgrCite");
    const out = await run(
      w,
      provider((ids) =>
        good(ids, { citations: [{ sourceType: "Renewal", sourceId: "ren_not_given" }] }),
      ),
    );
    expect(out).toMatchObject({ status: "UNCITED" });
    expect(await w.db.approval.count()).toBe(0);
  });

  it("another workspace's renewal is unreachable: no records, nothing to act on", async () => {
    const a = await world("RenMgrIsoA");
    const b = await world("RenMgrIsoB");
    const out = await runAgent(
      a.actor,
      renewalManager,
      { renewalId: b.renewal.id },
      { type: "signal", id: "x" },
      { provider: provider((ids) => good(ids)) },
    );
    // The bundle is empty, so the model has nothing it may cite: the run cannot succeed.
    expect(out).toMatchObject({ kind: "run" });
    if (out.kind === "run") expect(out.status).not.toBe("SUCCEEDED");
    expect(await b.db.document.count()).toBe(0);
    expect(await a.db.document.count()).toBe(0);
  });
});
