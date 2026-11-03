import { describe, expect, it } from "vitest";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { recomputeAccounts } from "@/modules/health/service";
import { createTestAdmin } from "@/test/fixtures";
import { backfillExtractions } from "../definitions/watcher";

/**
 * Watcher-basic end to end (M4 §2, D-75): existing ticket messages → one extraction run each →
 * only verified items written (an invented quote is dropped and recorded on the run) → ticket
 * sentiment labels → the Sentiment pillar scores from them, citing the messages. A fake provider
 * stands in for the model; re-running extracts nothing twice.
 */
const clock = () => new Date("2026-11-03T12:00:00Z");

function provider() {
  const calls: string[] = [];
  const p: AiProvider = {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      const id = /"sourceId": "([^"]+)"/.exec(req.input)![1]!;
      calls.push(id);
      const text = /"text": "([^"]*)"/.exec(req.input)![1]!;
      const negative = text.includes("losing patience");
      return {
        output: {
          reasoningSummary: "Labelled the message.",
          confidence: 0.8,
          citations: [{ sourceType: "Message", sourceId: id }],
          proposedActions: [],
          items: negative
            ? [
                {
                  kind: "COMPLAINT",
                  quote: "the export has failed again",
                  confidence: 0.9,
                  payload: { theme: "export" },
                },
                {
                  kind: "COMPETITOR",
                  quote: "we are moving to Tallyfield",
                  confidence: 0.6,
                  payload: { competitorName: "Tallyfield" },
                },
              ]
            : [],
          sentiment: negative
            ? { label: "NEGATIVE", quote: "We are losing patience." }
            : { label: "POSITIVE", quote: text.slice(0, 12) },
        } as T,
        stopReason: "end_turn",
        model: "model-from-env-fast",
        requestId: null,
        inputTokens: 5,
        outputTokens: 5,
        latencyMs: 1,
      };
    },
  };
  return { p, calls };
}

describe("Watcher-basic", () => {
  it("writes only verified extractions, labels ticket messages, and feeds the Sentiment pillar", async () => {
    const { actor } = await createTestAdmin("Watcher");
    const db = scopedDb(actor);
    const ws = actor.workspaceId;
    const account = await db.account.create({
      data: { workspaceId: ws, name: "Halden", tier: "MID_TOUCH" },
    });
    const conv = await db.conversation.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        channel: "TICKET",
        subject: "Export",
        startedAt: new Date("2026-10-30T15:00:00Z"),
        lastMessageAt: new Date("2026-10-31T15:00:00Z"),
      },
    });
    const msg = (bodyText: string, day: string) =>
      db.message.create({
        data: {
          workspaceId: ws,
          accountId: account.id,
          conversationId: conv.id,
          direction: "INBOUND",
          sentAt: new Date(`${day}T15:00:00Z`),
          subject: "Export",
          bodyText,
        },
      });
    const angry = await msg(
      "Hi, the export has failed again. We are losing patience.",
      "2026-10-30",
    );
    const happy = await msg("Thanks, the fix works great now.", "2026-10-31");
    const { p, calls } = provider();

    const first = await backfillExtractions(actor, {}, { provider: p, clock });
    expect(first).toMatchObject({ notConfigured: false, sources: 2, counts: { SUCCEEDED: 2 } });

    const rows = await db.extraction.findMany({
      where: { sourceId: angry.id },
      orderBy: { itemIndex: "asc" },
    });
    expect(rows.map((r) => [r.kind, r.quote, r.promptVersion])).toEqual([
      ["SENTIMENT", "We are losing patience.", "1.0.0"],
      ["COMPLAINT", "the export has failed again", "1.0.0"],
    ]);
    expect(rows.every((r) => r.origin === "AI" && r.agentRunId)).toBe(true);
    const run = await db.agentRun.findFirstOrThrow({
      where: { agentKey: "watcher", triggerId: { contains: angry.id } },
    });
    expect(run.effects).toContainEqual({
      type: "DroppedExtraction",
      id: "item 1 (COMPETITOR): quote not found in the source text",
    });
    expect(await db.message.findUniqueOrThrow({ where: { id: angry.id } })).toMatchObject({
      sentimentLabel: "NEGATIVE",
      sentimentAgentRunId: run.id,
    });
    expect((await db.message.findUniqueOrThrow({ where: { id: happy.id } })).sentimentLabel).toBe(
      "POSITIVE",
    );

    // Idempotent by (source, prompt version): nothing runs twice.
    expect(await backfillExtractions(actor, {}, { provider: p, clock })).toMatchObject({
      sources: 0,
    });
    expect(calls).toHaveLength(2);

    await recomputeAccounts(actor, [account.id], clock);
    const snap = await db.healthScoreSnapshot.findFirstOrThrow({
      where: { accountId: account.id },
      include: { reasons: { where: { component: "sentiment_share" } } },
    });
    expect(Number(snap.sentiment)).toBe(50);
    expect(snap.reasons[0]).toMatchObject({ kind: "EVIDENCE" });
    expect(
      (snap.reasons[0]!.sources as Array<{ sourceId: string }>).map((s) => s.sourceId).sort(),
    ).toEqual([angry.id, happy.id].sort());
  });

  it("with no API key it stops at not configured and writes nothing", async () => {
    const { actor } = await createTestAdmin("WatcherNoKey");
    const db = scopedDb(actor);
    const account = await db.account.create({
      data: { workspaceId: actor.workspaceId, name: "Q", tier: "MID_TOUCH" },
    });
    const conv = await db.conversation.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: account.id,
        channel: "TICKET",
        subject: "x",
        startedAt: new Date(),
        lastMessageAt: new Date(),
      },
    });
    await db.message.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: account.id,
        conversationId: conv.id,
        direction: "INBOUND",
        sentAt: new Date(),
        subject: "x",
        bodyText: "We will cancel.",
      },
    });
    expect(await backfillExtractions(actor)).toMatchObject({ notConfigured: true });
    expect(await db.extraction.count()).toBe(0);
    expect(await db.agentRun.count()).toBe(0);
  });
});
