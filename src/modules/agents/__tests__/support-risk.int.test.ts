import { describe, expect, it } from "vitest";
import type { AiProvider } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { addExtraction } from "@/test/extraction-fixtures";
import { syncInbox } from "@/modules/inbox/service";
import { runAgent } from "../executor";
import { supportRisk } from "../definitions/support-risk";

/**
 * Support Risk Agent (M9 B2): a risk narrative citing the customer's own words and a reply draft
 * that lands in Approvals. It sends nothing; every draft is an Approval + OutboundMessage that a
 * person decides (Rule 3); the draft cites what the customer wrote (Rules 1, 5).
 */
const NOW = new Date("2026-11-02T12:00:00Z");

async function world(
  label: string,
  o: {
    body: string;
    tier?: "HIGH_TOUCH" | "MID_TOUCH" | "LONG_TAIL";
    withContact?: boolean;
    kinds?: Array<[Parameters<typeof addExtraction>[1]["kind"], string, Record<string, unknown>]>;
  },
) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Halden Retail",
      tier: o.tier ?? "MID_TOUCH",
      domain: "halden.test",
      ownerMembershipId: actor.membershipId,
    },
  });
  const contact =
    o.withContact === false
      ? null
      : await db.contact.create({
          data: {
            workspaceId: ws,
            accountId: account.id,
            name: "Elena Voss",
            email: "elena@halden.test",
          },
        });
  const conv = await db.conversation.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      channel: "EMAIL",
      subject: "CSV export failed again",
      startedAt: new Date("2026-11-01T13:00:00Z"),
      lastMessageAt: new Date("2026-11-01T13:00:00Z"),
    },
  });
  const msg = await db.message.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      conversationId: conv.id,
      direction: "INBOUND",
      fromContactId: contact?.id ?? null,
      fromAddress: "elena@halden.test",
      sentAt: new Date("2026-11-01T13:00:00Z"),
      subject: "CSV export failed again",
      bodyText: o.body,
    },
  });
  for (const [i, [kind, quote, payload]] of (o.kinds ?? []).entries())
    await addExtraction(db, {
      workspaceId: ws,
      accountId: account.id,
      sourceType: "MESSAGE",
      sourceId: msg.id,
      kind,
      quote,
      payload,
      itemIndex: i,
    });
  await syncInbox(actor, { now: NOW });
  const item = await db.inboxItem.findFirstOrThrow({ where: { sourceId: msg.id } });
  return { actor, db, ws, account, contact, msg, item };
}

const provider = (
  answer: (w: { msgId: string; accountId: string }) => Record<string, unknown>,
  ids: { msgId: string; accountId: string },
): AiProvider => ({
  name: "recorded",
  async generateStructured<T>() {
    return {
      output: {
        reasoningSummary: "Read the customer's message.",
        confidence: 0.8,
        proposedActions: [],
        ...answer(ids),
      } as T,
      stopReason: "end_turn",
      model: "recorded",
      requestId: null,
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    };
  },
});

const REPLY = {
  subject: "Re: CSV export failed again",
  body: "Hi Elena,\n\nThank you for telling us the CSV export failed again during month-end. I am looking into it with our engineers and would be glad to talk it through on a call.\n\nBest,\nLeo",
};
const cite = (w: { msgId: string; accountId: string }) => [
  { sourceType: "Message", sourceId: w.msgId },
  { sourceType: "Account", sourceId: w.accountId },
];

describe("Support Risk Agent", () => {
  it("drafts a reply into Approvals that cites the customer's message, links the inbox item, and sends nothing", async () => {
    const w = await world("SrDraft", {
      body: "This is the third time the CSV export has failed during month-end.",
      kinds: [["COMPLAINT", "the CSV export has failed", { theme: "csv_export" }]],
    });
    const out = await runAgent(
      w.actor,
      supportRisk,
      { inboxItemId: w.item.id, requestedByMembershipId: w.actor.membershipId, nonce: "n1" },
      { type: "inbox", id: `${w.item.id}:n1` },
      {
        provider: provider(
          (ids) => ({
            citations: cite(ids),
            riskNarrative:
              "The customer says the CSV export keeps failing at month-end; this is a repeat problem.",
            reply: REPLY,
          }),
          { msgId: w.msg.id, accountId: w.account.id },
        ),
      },
    );
    expect(out).toMatchObject({ kind: "run", status: "SUCCEEDED" });
    const approval = await w.db.approval.findFirstOrThrow({ where: { accountId: w.account.id } });
    expect(approval).toMatchObject({
      kind: "SEND_EMAIL",
      status: "PENDING",
      requiredLevel: "DRAFT_FOR_APPROVAL",
    });
    expect(JSON.stringify(approval.proof)).toContain(w.msg.id);
    const draft = await w.db.outboundMessage.findFirstOrThrow({
      where: { approvalId: approval.id },
    });
    expect(draft).toMatchObject({
      status: "AWAITING_APPROVAL",
      contactId: w.contact!.id,
      subject: REPLY.subject,
    });
    const item = await w.db.inboxItem.findUniqueOrThrow({ where: { id: w.item.id } });
    expect(item).toMatchObject({ status: "DRAFTED", draftOutboundMessageId: draft.id });
    expect(await w.db.outboundMessage.count({ where: { status: "SENT" } })).toBe(0);
    const run = await w.db.agentRun.findFirstOrThrow({ where: { agentKey: "support-risk" } });
    expect(run.status).toBe("SUCCEEDED");
    expect(JSON.stringify(run.output)).toContain("repeat problem");
  });

  it("a draft that cites none of the customer's words is not a draft: the run is UNCITED, nothing lands in Approvals", async () => {
    const w = await world("SrUncited", { body: "The export failed again.", kinds: [] });
    const out = await runAgent(
      w.actor,
      supportRisk,
      { inboxItemId: w.item.id, nonce: "n1" },
      { type: "inbox", id: `${w.item.id}:n1` },
      {
        provider: provider(
          (ids) => ({
            citations: [{ sourceType: "Account", sourceId: ids.accountId }],
            riskNarrative: "A customer wrote in.",
            reply: REPLY,
          }),
          { msgId: w.msg.id, accountId: w.account.id },
        ),
      },
    );
    expect(out).toMatchObject({ kind: "run", status: "UNCITED" });
    expect(await w.db.approval.count()).toBe(0);
    expect((await w.db.inboxItem.findUniqueOrThrow({ where: { id: w.item.id } })).status).toBe(
      "NEW",
    );
  });

  it("no contact with an email to answer: the narrative is kept on the run, no draft is made", async () => {
    const w = await world("SrNoContact", { body: "The export failed again.", withContact: false });
    const out = await runAgent(
      w.actor,
      supportRisk,
      { inboxItemId: w.item.id, nonce: "n1" },
      { type: "inbox", id: `${w.item.id}:n1` },
      {
        provider: provider(
          (ids) => ({
            citations: cite(ids),
            riskNarrative: "Someone at the customer reports a failing export.",
            reply: REPLY,
          }),
          { msgId: w.msg.id, accountId: w.account.id },
        ),
      },
    );
    expect(out).toMatchObject({ kind: "run", status: "SUCCEEDED" });
    expect(await w.db.approval.count()).toBe(0);
    expect(await w.db.outboundMessage.count()).toBe(0);
  });

  it("is idempotent for the same request and makes a second draft only for a new one", async () => {
    const w = await world("SrIdem", { body: "The export failed again.", kinds: [] });
    const p = provider(
      (ids) => ({ citations: cite(ids), riskNarrative: "Export failing.", reply: REPLY }),
      { msgId: w.msg.id, accountId: w.account.id },
    );
    for (const nonce of ["a", "a"])
      await runAgent(
        w.actor,
        supportRisk,
        { inboxItemId: w.item.id, nonce },
        { type: "inbox", id: `${w.item.id}:${nonce}` },
        { provider: p },
      );
    expect(await w.db.approval.count()).toBe(1);
  });

  it("another workspace's inbox item is not found: no run reads it", async () => {
    const a = await world("SrIsoA", { body: "x" });
    const b = await world("SrIsoB", { body: "y" });
    const out = await runAgent(
      b.actor,
      supportRisk,
      { inboxItemId: a.item.id, nonce: "n" },
      { type: "inbox", id: `${a.item.id}:n` },
      {
        provider: provider((ids) => ({ citations: cite(ids), riskNarrative: "x", reply: REPLY }), {
          msgId: a.msg.id,
          accountId: a.account.id,
        }),
      },
    );
    expect(out.kind === "run" && out.status).not.toBe("SUCCEEDED");
    expect(await b.db.approval.count()).toBe(0);
  });
});
