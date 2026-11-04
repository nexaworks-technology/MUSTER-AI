import { beforeAll, describe, expect, it } from "vitest";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import { addDays, businessClock, todayIn, utcMidnight } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { listOpportunities } from "@/modules/expansion/service";
import { createTestAdmin } from "@/test/fixtures";
import { runAgent } from "../executor";
import { expansionFinder } from "../definitions/expansion-finder";
import { renderableRun } from "../service";

/**
 * M7 B4 Expansion Finder (recorded provider): it cites the usage and limit records it was given;
 * the estimate is never in its records and never typed by it (a placeholder that code fills in,
 * "Restricted" for a reader without revenue access); the conversation draft goes to Approvals with
 * no money in it and nothing is sent; a typed figure is UNCITED; a model-supplied estimate in a
 * proposed action is replaced by the opportunity's own figure.
 */
type World = Awaited<ReturnType<typeof world>>;
const TODAY = todayIn("UTC", businessClock);
const d = (n: number) => utcMidnight(addDays(TODAY, n));

async function world(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Copperleaf Studios",
      tier: "MID_TOUCH",
      plan: "Growth",
      ownerMembershipId: actor.membershipId,
    },
  });
  const contact = await db.contact.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      name: "Iris Tan",
      title: "Studio Operations Lead",
      email: "iris@copperleaf-studios.test",
    },
  });
  const contract = await db.contract.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      startDate: d(-200),
      endDate: d(140),
      renewalDate: d(140),
      valueMinor: 3_600_000n,
      seatsPurchased: 40,
    },
  });
  await db.usageDaily.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      date: d(-1),
      activeUsers: 52,
      sessions: 60,
      events: 900,
      seatsUsed: 52,
    },
  });
  const signal = await db.signal.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      ruleKey: "seats_near_limit",
      ruleVersion: 1,
      category: "USAGE",
      severity: "WARN",
      polarity: "OPPORTUNITY",
      title: "52 of 40 seats in use",
      explanation:
        "52 people used the product in the last 28 days on a contract for 40 seats (130%).",
      evidence: [{ sourceType: "Contract", sourceId: contract.id }],
      values: { ratio: 1.3, used: 52, seats: 40 },
      params: {},
      dedupeKey: `seats_near_limit:${account.id}:${contract.id}`,
      firstSeenAt: d(-1),
      lastSeenAt: d(0),
    },
  });
  const opp = await db.expansionOpportunity.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      signalIds: [signal.id],
      estimateMinor: 1_080_000n,
      currency: "USD",
      estimateMethod: "SEATS_OVER_LIMIT",
      ownerMembershipId: actor.membershipId,
    },
  });
  return { actor, db, ws, account, contact, contract, signal, opp };
}

function provider(output: (ids: Record<string, string>) => unknown, seen: string[] = []) {
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
  return p;
}

const good = (ids: Record<string, string>, over: Record<string, unknown> = {}) => ({
  reasoningSummary: "More people use the product than the contract has seats for.",
  confidence: 0.8,
  citations: [
    { sourceType: "Signal", sourceId: ids.Signal },
    { sourceType: "Contract", sourceId: ids.Contract },
    { sourceType: "UsageDaily", sourceId: ids.UsageDaily },
  ],
  proposedActions: [],
  narrative:
    "52 people used the product in the last 28 days on 40 seats. Size: {{metric.expansion.estimate}}.",
  conversation: {
    subject: "Your team on Larkspur",
    body: "Hi Iris,\n\nI noticed 52 people have been using Larkspur recently, more than the 40 seats on your plan. How are the plans for the team going? Happy to talk through options.\n\nAisha",
  },
  ...over,
});

const run = (w: World, p: AiProvider) =>
  runAgent(
    w.actor,
    expansionFinder,
    { opportunityId: w.opp.id },
    { type: "opportunity", id: w.opp.id },
    { provider: p },
  );

let W: World;
beforeAll(async () => {
  W = await world("ExpFinder");
});

describe("Expansion Finder (M7 B4)", () => {
  it("is given usage and limit records and never the estimate", async () => {
    const seen: string[] = [];
    const out = await run(
      W,
      provider((ids) => good(ids), seen),
    );
    expect(out).toMatchObject({ kind: "run", status: "SUCCEEDED" });
    expect(seen[0]).toContain("52 of 40 seats in use");
    expect(seen[0]).toContain('"seatsPurchased": 40');
    expect(seen[0]).toContain('"activeUsers": 52');
    expect(seen[0]).not.toMatch(/10,800|1080000|\$900|900\.00/);
  });

  it("drafts the conversation into Approvals with no money in it, and sends nothing", async () => {
    const r = await W.db.agentRun.findFirstOrThrow({ where: { agentKey: "expansion-finder" } });
    expect(r.actionTaken).toBe("APPROVAL_REQUESTED");
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
      toEmail: "iris@copperleaf-studios.test",
      origin: "AI",
      agentRunId: r.id,
    });
    expect(message.sentAt).toBeNull();
    expect(message.bodyText).not.toMatch(/\{\{|\$|10,800/);
    expect(JSON.stringify(approval.proof)).toContain(W.signal.id);
  });

  it("records what Rule 5 asks for", async () => {
    const r = await W.db.agentRun.findFirstOrThrow({ where: { agentKey: "expansion-finder" } });
    expect(r).toMatchObject({
      promptName: "expansion-finder",
      promptVersion: "1.0.0",
      model: "model-from-env-standard",
      status: "SUCCEEDED",
    });
    expect(r.reasoningSummary).toBeTruthy();
    expect(r.confidence).not.toBeNull();
    expect(JSON.stringify(r.inputRefs)).toContain(W.opp.id);
    expect(r.output).not.toBeNull();
  });

  it("the note reads with the estimate filled in by code and its method; hidden without revenue access", async () => {
    const withMoney = (await listOpportunities(W.actor)).rows[0]!;
    expect(withMoney.finder!.note).toContain(
      "Size: an estimate of $10,800.00 ARR (12 seats × $900.00 per seat, from their subscription).",
    );
    expect(withMoney.finder!.note).not.toContain("{{");
    const without = (await listOpportunities({ ...W.actor, canViewRevenue: false })).rows[0]!;
    expect(without.finder!.note).toContain("Size: Restricted.");
    expect(JSON.stringify(without)).not.toMatch(/10,800|1080000/);
  });

  it("a typed money figure is UNCITED: nothing rendered, nothing written", async () => {
    const w = await world("ExpFinderTyped");
    const out = await run(
      w,
      provider((ids) => good(ids, { narrative: "About $10,800 a year is possible." })),
    );
    expect(out).toMatchObject({ status: "UNCITED" });
    if (out.kind !== "run") throw new Error("unreachable");
    expect(await renderableRun(w.actor, out.runId)).toBeNull();
    expect(await w.db.approval.count()).toBe(0);
  });

  it("the estimate placeholder in the customer draft is INVALID_OUTPUT", async () => {
    const w = await world("ExpFinderLeak");
    const out = await run(
      w,
      provider((ids) =>
        good(ids, {
          conversation: {
            subject: "Seats",
            body: "Hi Iris, add seats for {{metric.expansion.estimate}}.",
          },
        }),
      ),
    );
    expect(out).toMatchObject({ status: "INVALID_OUTPUT" });
    expect(await w.db.outboundMessage.count()).toBe(0);
  });

  it("replaces a model-supplied estimate in a proposed action with the opportunity's own figure", async () => {
    const w = await world("ExpFinderFacts");
    const out = await run(
      w,
      provider((ids) =>
        good(ids, {
          proposedActions: [
            { type: "FOLLOW_UP", summary: "Talk seats", estimate: 5, confidence: 0.1 },
          ],
        }),
      ),
    );
    expect(out).toMatchObject({ status: "SUCCEEDED" });
    const r = await w.db.agentRun.findFirstOrThrow();
    const action = (r.output as { proposedActions: Array<Record<string, unknown>> })
      .proposedActions[0]!;
    expect(action.estimate).toBe(1_080_000);
  });

  it("a closed or dismissed opportunity gives the agent nothing to cite", async () => {
    const w = await world("ExpFinderClosed");
    await w.db.expansionOpportunity.update({
      where: { id: w.opp.id },
      data: { status: "DISMISSED" },
    });
    const out = await run(
      w,
      provider((ids) => good(ids)),
    );
    expect(out).toMatchObject({ kind: "run" });
    if (out.kind === "run") expect(out.status).not.toBe("SUCCEEDED");
    expect(await w.db.approval.count()).toBe(0);
  });
});
