import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { addExtraction } from "@/test/extraction-fixtures";
import { countQueries } from "@/test/query-counter";
import { listConversations } from "../service";

/** Account 360 › Conversations (M9 B1, Rule 4): labels are read from Extraction at display, latest prompt version only. */
async function world(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const account = await db.account.create({ data: { workspaceId: ws, name: "Brightwell", tier: "HIGH_TOUCH", ownerMembershipId: actor.membershipId } });
  const email = async (n: number) => {
    const at = new Date(`2026-10-${10 + n}T10:00:00Z`);
    const conv = await db.conversation.create({ data: { workspaceId: ws, accountId: account.id, channel: "EMAIL", subject: `S${n}`, startedAt: at, lastMessageAt: at } });
    return db.message.create({ data: { workspaceId: ws, accountId: account.id, conversationId: conv.id, direction: "INBOUND", sentAt: at, subject: `S${n}`, bodyText: `body ${n}` } });
  };
  const call = async () => {
    const at = new Date("2026-10-21T15:00:00Z");
    const conv = await db.conversation.create({ data: { workspaceId: ws, accountId: account.id, channel: "CALL", subject: "Check-in", startedAt: at, lastMessageAt: at } });
    return db.callTranscript.create({ data: { workspaceId: ws, conversationId: conv.id, accountId: account.id, title: "Check-in", provider: "seed", occurredAt: at, text: "Ben: Our CFO asked us to look at Tallyfield before renewal." } });
  };
  return { actor, db, ws, account, email, call };
}

describe("listConversations labels", () => {
  it("shows what the Watcher read, with the verbatim quote, on messages and on calls", async () => {
    const w = await world("ConvLabels");
    const m = await w.email(1);
    const t = await w.call();
    await addExtraction(w.db, { workspaceId: w.ws, accountId: w.account.id, sourceType: "MESSAGE", sourceId: m.id, kind: "SENTIMENT", quote: "body 1", payload: { label: "NEGATIVE" }, itemIndex: -1 });
    await addExtraction(w.db, { workspaceId: w.ws, accountId: w.account.id, sourceType: "CALL_TRANSCRIPT", sourceId: t.id, kind: "COMPETITOR", quote: "Our CFO asked us to look at Tallyfield before renewal.", payload: { competitorName: "Tallyfield" } });
    const { conversations } = await listConversations(w.actor, w.account.id);
    const msg = conversations.flatMap((c) => c.messages).find((x) => x.id === m.id)!;
    expect(msg.labels).toEqual([{ kind: "SENTIMENT", text: "Sentiment: negative", tone: "negative", quote: "body 1" }]);
    const tr = conversations.flatMap((c) => c.transcripts).find((x) => x.id === t.id)!;
    expect(tr.labels).toEqual([{ kind: "COMPETITOR", text: "Competitor: Tallyfield", tone: "risk", quote: "Our CFO asked us to look at Tallyfield before renewal." }]);
  });

  it("an unread message has no labels (nothing is invented)", async () => {
    const w = await world("ConvNone");
    await w.email(1);
    const { conversations } = await listConversations(w.actor, w.account.id);
    expect(conversations[0]!.messages[0]!.labels).toEqual([]);
  });

  it("only the newest prompt version's labels show", async () => {
    const w = await world("ConvVersion");
    const m = await w.email(1);
    await addExtraction(w.db, { workspaceId: w.ws, accountId: w.account.id, sourceType: "MESSAGE", sourceId: m.id, kind: "INTENT", quote: "body 1", payload: { intent: "question" }, version: "1.0.0" });
    await addExtraction(w.db, { workspaceId: w.ws, accountId: w.account.id, sourceType: "MESSAGE", sourceId: m.id, kind: "INTENT", quote: "body 1", payload: { intent: "request" }, version: "1.1.0" });
    const { conversations } = await listConversations(w.actor, w.account.id);
    expect(conversations[0]!.messages[0]!.labels.map((l) => l.text)).toEqual(["Intent: request"]);
  });

  it("reads a fixed number of times for 2 conversations and for 8", async () => {
    const w = await world("ConvBudget");
    for (const n of [1, 2]) {
      const m = await w.email(n);
      await addExtraction(w.db, { workspaceId: w.ws, accountId: w.account.id, sourceType: "MESSAGE", sourceId: m.id, kind: "INTENT", quote: "x", payload: { intent: "question" } });
    }
    const two = await countQueries(() => listConversations(w.actor, w.account.id));
    for (const n of [3, 4, 5, 6, 7, 8]) {
      const m = await w.email(n);
      await addExtraction(w.db, { workspaceId: w.ws, accountId: w.account.id, sourceType: "MESSAGE", sourceId: m.id, kind: "INTENT", quote: "x", payload: { intent: "question" } });
    }
    const eight = await countQueries(() => listConversations(w.actor, w.account.id));
    expect(eight.result.conversations.length).toBe(8);
    expect(eight.queries).toBe(two.queries);
  });
});
