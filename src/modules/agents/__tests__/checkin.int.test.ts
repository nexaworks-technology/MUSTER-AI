import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { approve, getApproval } from "@/modules/approvals/service";
import { createTestAdmin } from "@/test/fixtures";
import { draftCheckIn } from "../checkin";

/**
 * "Draft check-in" (M4 §2, demo steps 3–5): from a signal or a ticket, by the Outreach Agent or
 * by hand, the result is a draft + a PENDING approval. A sensitive ticket marks it "Always human";
 * an approved AI draft sends through dispatch. Fake provider and fake transport only.
 */
const clock = () => new Date("2026-11-03T15:00:00Z");
const transport = { name: "log" as const, send: async () => ({ id: `fake-${randomUUID()}` }) };

let admin: Actor;
let leo: Actor;
let db: ScopedDb;
let accountId: string;
let otherAccountId: string;
let contactId: string;
let signalId: string;
let ticketId: string;

beforeAll(async () => {
  ({ actor: admin } = await createTestAdmin("CheckIn"));
  db = scopedDb(admin);
  const ws = admin.workspaceId;
  const user = await rawDb.user.create({
    data: { email: `leo-${randomUUID()}@t.test`, name: "Leo Marsh" },
  });
  const m = await db.membership.create({ data: { workspaceId: ws, userId: user.id, role: "CSM" } });
  leo = {
    workspaceId: ws,
    userId: user.id,
    membershipId: m.id,
    role: "CSM",
    canViewRevenue: false,
    bookScope: "OWN",
  };
  accountId = (
    await db.account.create({
      data: {
        workspaceId: ws,
        name: "Brightwell",
        tier: "HIGH_TOUCH",
        ownerMembershipId: m.id,
        timezone: "America/New_York",
      },
    })
  ).id;
  otherAccountId = (
    await db.account.create({ data: { workspaceId: ws, name: "Quillmark", tier: "MID_TOUCH" } })
  ).id;
  contactId = (
    await db.contact.create({
      data: { workspaceId: ws, accountId, name: "Dana Reyes", email: "dana@brightwell.test" },
    })
  ).id;
  signalId = (
    await db.signal.create({
      data: {
        workspaceId: ws,
        accountId,
        ruleKey: "usage_drop_vs_normal",
        ruleVersion: 1,
        category: "USAGE",
        severity: "CRITICAL",
        polarity: "RISK",
        title: "Usage drop vs normal",
        explanation: "Weekday active users are 49% below this account's normal.",
        evidence: [{ sourceType: "Account", sourceId: accountId }],
        values: {},
        params: {},
        dedupeKey: `drop:${accountId}`,
        firstSeenAt: new Date("2026-10-20"),
        lastSeenAt: new Date("2026-11-02"),
      },
    })
  ).id;
  const conv = await db.conversation.create({
    data: {
      workspaceId: ws,
      accountId,
      channel: "TICKET",
      subject: "Exporting our data",
      startedAt: clock(),
      lastMessageAt: clock(),
    },
  });
  await db.message.create({
    data: {
      workspaceId: ws,
      accountId,
      conversationId: conv.id,
      direction: "INBOUND",
      sentAt: clock(),
      subject: "Exporting our data",
      bodyText: "How do I export all our data before we cancel at the end of the term?",
    },
  });
  ticketId = (
    await db.ticket.create({
      data: {
        workspaceId: ws,
        accountId,
        conversationId: conv.id,
        subject: "Exporting our data",
        openedAt: clock(),
      },
    })
  ).id;
});

function provider(output: (ids: string[]) => unknown) {
  const calls: number[] = [];
  const p: AiProvider = {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      calls.push(1);
      const ids = [...req.input.matchAll(/"sourceId": "([^"]+)"/g)].map((x) => x[1]!);
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
  return { p, calls };
}
const nonce = () => randomUUID();

describe("Draft check-in", () => {
  it("by hand: a draft and a PENDING approval with the signal as proof; nothing is sent", async () => {
    const r = await draftCheckIn(leo, {
      sourceType: "Signal",
      sourceId: signalId,
      contactId,
      nonce: nonce(),
      mode: "human",
      subject: "Checking in",
      body: "Hi Dana, want a quick walkthrough?",
    });
    expect(r).toMatchObject({ status: "DRAFTED", by: "human" });
    if (r.status !== "DRAFTED") return;
    const a = await getApproval(leo, r.approvalId);
    expect(a).toMatchObject({
      status: "PENDING",
      isSensitive: false,
      proof: [{ sourceType: "Signal", sourceId: signalId }],
    });
    expect(a.outboundMessages[0]).toMatchObject({
      status: "AWAITING_APPROVAL",
      origin: "HUMAN",
      sentAt: null,
    });
  });

  it("from a ticket with cancellation language: marked sensitive, always human", async () => {
    const r = await draftCheckIn(leo, {
      sourceType: "Ticket",
      sourceId: ticketId,
      contactId,
      nonce: nonce(),
      mode: "human",
      subject: "About your export",
      body: "Hi Dana, could we talk this week?",
    });
    if (r.status !== "DRAFTED") throw new Error(r.status);
    expect(await getApproval(leo, r.approvalId)).toMatchObject({
      isSensitive: true,
      sensitiveReasons: ["cancellation"],
      requiredLevel: "DRAFT_FOR_APPROVAL",
    });
  });

  it("by the Outreach Agent: an AI draft citing the signal, which sends once approved", async () => {
    const { p } = provider(() => ({
      reasoningSummary: "Usage fell; offer help.",
      confidence: 0.7,
      proposedActions: [],
      citations: [
        { sourceType: "Signal", sourceId: signalId },
        { sourceType: "Contact", sourceId: contactId },
      ],
      subject: "Quick check-in",
      body: "Hi Dana, your team's weekday use is 49% below its normal. Want a walkthrough?",
    }));
    const r = await draftCheckIn(
      leo,
      { sourceType: "Signal", sourceId: signalId, contactId, nonce: nonce(), mode: "ai" },
      { provider: p },
    );
    expect(r).toMatchObject({ status: "DRAFTED", by: "ai" });
    if (r.status !== "DRAFTED") return;
    const a = await getApproval(leo, r.approvalId);
    expect(a.proposedByAgentRunId).toBeTruthy();
    expect(a.revisions[0]).toMatchObject({
      version: 1,
      origin: "AI",
      agentRunId: a.proposedByAgentRunId,
    });
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: a.proposedByAgentRunId! } });
    expect(run).toMatchObject({
      agentKey: "outreach",
      status: "SUCCEEDED",
      actionTaken: "APPROVAL_REQUESTED",
    });
    const sent = await approve(
      leo,
      { approvalId: a.id },
      { clock, dispatch: { clock, transport } },
    );
    expect(sent.send).toMatchObject({ status: "SENT" });
  });

  it("when the AI has nothing to say, no draft is made and the gap is named", async () => {
    const { p } = provider(() => ({
      reasoningSummary: "Nothing to write about.",
      confidence: 0.2,
      proposedActions: [],
      citations: [{ sourceType: "Signal", sourceId: signalId }],
      subject: null,
      body: null,
      insufficientData: { missing: ["a customer message"] },
    }));
    const before = await db.approval.count();
    const r = await draftCheckIn(
      leo,
      { sourceType: "Signal", sourceId: signalId, contactId, nonce: nonce(), mode: "ai" },
      { provider: p },
    );
    expect(r).toMatchObject({ status: "NO_DRAFT", missing: ["a customer message"] });
    expect(await db.approval.count()).toBe(before);
  });

  it("an uncited AI draft is RUN_FAILED and saves nothing", async () => {
    const { p } = provider(() => ({
      reasoningSummary: "r",
      confidence: 0.5,
      proposedActions: [],
      citations: [{ sourceType: "Signal", sourceId: signalId }],
      subject: "Checking in",
      body: "Your usage fell 70% last quarter.",
    }));
    const before = await db.approval.count();
    expect(
      await draftCheckIn(
        leo,
        { sourceType: "Signal", sourceId: signalId, contactId, nonce: nonce(), mode: "ai" },
        { provider: p },
      ),
    ).toMatchObject({ status: "RUN_FAILED", runStatus: "UNCITED" });
    expect(await db.approval.count()).toBe(before);
  });

  it("with no API key the AI path says not configured; a CSM outside the book cannot draft", async () => {
    expect(
      await draftCheckIn(leo, {
        sourceType: "Signal",
        sourceId: signalId,
        contactId,
        nonce: nonce(),
        mode: "ai",
      }),
    ).toEqual({ status: "NOT_CONFIGURED" });
    const otherContact = await db.contact.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: otherAccountId,
        name: "G",
        email: "g@q.test",
      },
    });
    const otherTicket = await db.ticket.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: otherAccountId,
        subject: "x",
        openedAt: clock(),
      },
    });
    await expect(
      draftCheckIn(leo, {
        sourceType: "Ticket",
        sourceId: otherTicket.id,
        contactId: otherContact.id,
        nonce: nonce(),
        mode: "human",
        subject: "s",
        body: "b",
      }),
    ).rejects.toThrow(/not found/i);
  });
});
