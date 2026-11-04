import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { inputsHash } from "../engine";
import { loadBundles, loadContext } from "../service";

/**
 * M9 D4: no second sentiment path. Only ticket-thread sentiment labels are a health input (the M4
 * path, unchanged). A label on an email or any other channel must change neither the bundle the
 * scorer reads nor its input hash, so email sentiment is shown but never scored, by construction.
 */
const ASOF = "2026-11-02";

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const account = await db.account.create({
    data: { workspaceId: ws, name: "Halden", tier: "MID_TOUCH" },
  });
  const mk = async (channel: "EMAIL" | "TICKET", day: string) => {
    const conv = await db.conversation.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        channel,
        subject: "s",
        startedAt: new Date(day),
        lastMessageAt: new Date(day),
      },
    });
    return db.message.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        conversationId: conv.id,
        direction: "INBOUND",
        sentAt: new Date(`${day}T10:00:00Z`),
        subject: "s",
        bodyText: "text",
      },
    });
  };
  const bundle = async () => {
    const hctx = await loadContext(actor);
    const b = (await loadBundles(db, hctx, ASOF, [account.id])).get(account.id)!;
    return { b, hash: inputsHash(b, "model-1") };
  };
  return { actor, db, account, mk, bundle };
}

describe("the health input and sentiment labels", () => {
  it("a sentiment label on an email changes neither the bundle nor the input hash", async () => {
    const w = await setup("HashEmail");
    const email = await w.mk("EMAIL", "2026-10-30");
    const before = await w.bundle();
    const run = await w.db.agentRun.create({
      data: {
        workspaceId: w.actor.workspaceId,
        agentKey: "watcher",
        agentVersion: "1.1.0",
        promptName: "watcher-extraction",
        promptVersion: "1.1.0",
        model: "m",
        modelTier: "fast",
        triggerType: "extraction",
        triggerId: `MESSAGE:${email.id}@1.1.0`,
        idempotencyKey: `h-${email.id}`,
        inputRefs: [{ sourceType: "Message", sourceId: email.id }],
        accountId: w.account.id,
        status: "SUCCEEDED",
        output: { items: [] },
        reasoningSummary: "r",
        confidence: 0.8,
      },
    });
    await w.db.message.update({
      where: { id: email.id },
      data: { sentimentLabel: "NEGATIVE", sentimentAgentRunId: run.id },
    });
    const after = await w.bundle();
    expect(after.b.messages?.every((m) => m.sentimentLabel === undefined)).toBe(true);
    expect(after.hash).toBe(before.hash);
  });

  it("a label on a ticket message is a health input: it appears in the bundle and changes the hash (the M4 path)", async () => {
    const w = await setup("HashTicket");
    const t = await w.mk("TICKET", "2026-10-30");
    const before = await w.bundle();
    const run = await w.db.agentRun.create({
      data: {
        workspaceId: w.actor.workspaceId,
        agentKey: "watcher",
        agentVersion: "1.1.0",
        promptName: "watcher-extraction",
        promptVersion: "1.1.0",
        model: "m",
        modelTier: "fast",
        triggerType: "extraction",
        triggerId: `MESSAGE:${t.id}@1.1.0`,
        idempotencyKey: `h-${t.id}`,
        inputRefs: [{ sourceType: "Message", sourceId: t.id }],
        accountId: w.account.id,
        status: "SUCCEEDED",
        output: { items: [] },
        reasoningSummary: "r",
        confidence: 0.8,
      },
    });
    await w.db.message.update({
      where: { id: t.id },
      data: { sentimentLabel: "NEGATIVE", sentimentAgentRunId: run.id },
    });
    const after = await w.bundle();
    expect(after.b.messages?.find((m) => m.id === t.id)?.sentimentLabel).toBe("NEGATIVE");
    expect(after.hash).not.toBe(before.hash);
  });
});
