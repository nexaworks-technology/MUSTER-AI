import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import { logger } from "@/lib/logger";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { StaleReextractError } from "@/modules/conversations/service";
import { backfillExtractions, reextractSources, WATCHER_PROMPT } from "../definitions/watcher";

/**
 * Watcher (full) for M9: ticket/email messages in both directions and call transcripts read by
 * chunk. Every quote is verified against the chunk it was read from; customer-only labels are not
 * taken from our own messages; no log line carries the text (Rules 1, 5, 7).
 */
const clock = () => new Date("2026-11-03T12:00:00Z");
const PLANTED = "We will ship the API limit increase by October 30.";
const SECRET = "confidential-budget-remark-xyz";

afterEach(() => vi.restoreAllMocks());

function fakeProvider(answer: (input: string) => Record<string, unknown>) {
  const inputs: string[] = [];
  const p: AiProvider = {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      inputs.push(req.input);
      const id = /"sourceId": "([^"]+)"/.exec(req.input)![1]!;
      const sourceType = /"sourceType": "([^"]+)"/.exec(req.input)![1]!;
      return {
        output: {
          reasoningSummary: "Labelled the record.",
          confidence: 0.8,
          citations: [{ sourceType, sourceId: id }],
          proposedActions: [],
          ...answer(req.input),
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
  return { p, inputs };
}

async function workspace(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const account = await db.account.create({
    data: { workspaceId: ws, name: "Northgate", tier: "MID_TOUCH" },
  });
  return { actor, db, ws, account };
}

describe("Watcher (full): call transcripts by chunk", () => {
  it("reads each chunk once, verifies quotes against their own chunk, and records the chunk index", async () => {
    const { actor, db, ws, account } = await workspace("WatcherM9Call");
    const filler = (i: number) =>
      `Leo Marsh: ${`Line ${i} is routine talk about the reporting setup. `.repeat(14).trim()}`;
    const lines = Array.from({ length: 60 }, (_, i) => filler(i));
    lines.push(`Leo Marsh: ${PLANTED}`);
    lines.push(`Dora Lindqvist: ${SECRET} is what finance told us.`);
    const text = `Title: Quarterly review\nDate: 2026-10-15\nParticipants: Leo Marsh, Dora Lindqvist\n\n${lines.join("\n")}\n`;
    const conv = await db.conversation.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        channel: "CALL",
        subject: "QBR",
        startedAt: new Date("2026-10-15"),
        lastMessageAt: new Date("2026-10-15"),
      },
    });
    const transcript = await db.callTranscript.create({
      data: {
        workspaceId: ws,
        conversationId: conv.id,
        accountId: account.id,
        title: "QBR",
        provider: "seed",
        occurredAt: new Date("2026-10-15"),
        text,
      },
    });

    const logged: unknown[] = [];
    for (const level of ["info", "warn", "error", "debug"] as const)
      vi.spyOn(logger, level).mockImplementation(
        ((...a: unknown[]) => void logged.push(a)) as never,
      );

    // Every chunk answers with the planted promise; only the chunk that really holds it can verify.
    const { p, inputs } = fakeProvider(() => ({
      items: [
        {
          kind: "PROMISE",
          quote: PLANTED,
          confidence: 0.9,
          payload: { what: "API limit increase", dueDate: "2026-10-30", party: "us" },
        },
      ],
      sentiment: null,
    }));
    const first = await backfillExtractions(actor, {}, { provider: p, clock });
    expect(first).toMatchObject({ notConfigured: false, counts: { SUCCEEDED: inputs.length } });
    expect(inputs.length).toBeGreaterThanOrEqual(2);

    const rows = await db.extraction.findMany({ where: { sourceId: transcript.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceType: "CALL_TRANSCRIPT",
      kind: "PROMISE",
      quote: PLANTED,
      promptVersion: WATCHER_PROMPT.version,
    });
    const holder = inputs.findIndex((i) => i.includes(PLANTED));
    expect(rows[0]!.chunkIndex).toBe(holder);

    const runs = await db.agentRun.findMany({
      where: {
        agentKey: "watcher",
        triggerId: { startsWith: `CALL_TRANSCRIPT:${transcript.id}#` },
      },
    });
    expect(runs).toHaveLength(inputs.length);
    const dropped = runs.filter((r) =>
      JSON.stringify(r.effects).includes("quote not found in the source text"),
    );
    expect(dropped).toHaveLength(inputs.length - 1);

    // Idempotent: nothing is read twice at this prompt version.
    expect(await backfillExtractions(actor, {}, { provider: p, clock })).toMatchObject({
      sources: 0,
    });

    // Rule 7: no log line carries the transcript.
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    expect(JSON.stringify(logged)).not.toContain("routine talk");
  });
});

describe("Watcher (full): our own messages", () => {
  it("keeps our promises but takes no customer-only label from them", async () => {
    const { actor, db, ws, account } = await workspace("WatcherM9Out");
    const conv = await db.conversation.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        channel: "EMAIL",
        subject: "Guide",
        startedAt: new Date("2026-10-30"),
        lastMessageAt: new Date("2026-10-30"),
      },
    });
    const body =
      "I'll send the integration guide by Friday 6 November. Sorry the export keeps failing.";
    const out = await db.message.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        conversationId: conv.id,
        direction: "OUTBOUND",
        sentAt: new Date("2026-10-30T10:00:00Z"),
        subject: "Guide",
        bodyText: body,
      },
    });
    const { p } = fakeProvider(() => ({
      items: [
        {
          kind: "PROMISE",
          quote: "I'll send the integration guide by Friday 6 November.",
          confidence: 0.9,
          payload: { what: "Integration guide", dueDate: "2026-11-06", party: "us" },
        },
        {
          kind: "COMPLAINT",
          quote: "Sorry the export keeps failing.",
          confidence: 0.7,
          payload: { theme: "csv_export" },
        },
      ],
      sentiment: { label: "NEGATIVE", quote: "Sorry the export keeps failing." },
    }));
    await backfillExtractions(actor, {}, { provider: p, clock });

    const rows = await db.extraction.findMany({ where: { sourceId: out.id } });
    expect(rows.map((r) => r.kind)).toEqual(["PROMISE"]);
    expect(
      (await db.message.findUniqueOrThrow({ where: { id: out.id } })).sentimentLabel,
    ).toBeNull();
    const run = await db.agentRun.findFirstOrThrow({
      where: { agentKey: "watcher", triggerId: { contains: out.id } },
    });
    expect(run.effects).toContainEqual({
      type: "DroppedExtraction",
      id: "item 1 (COMPLAINT): customer-only label, not read from our own message",
    });
  });
});

describe("Watcher (full): the prompt version", () => {
  it("is 1.1.0 and the rows say so", () => {
    expect(WATCHER_PROMPT.version).toBe("1.1.0");
  });
});

describe("conversations.reextract (only on an explicit prompt-version bump)", () => {
  it("refuses a stale version and a workspace nothing has read, and re-reads only what an earlier version read", async () => {
    const { actor, db, ws, account } = await workspace("WatcherM9Re");
    const conv = await db.conversation.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        channel: "EMAIL",
        subject: "x",
        startedAt: new Date("2026-10-30"),
        lastMessageAt: new Date("2026-10-30"),
      },
    });
    const mk = (body: string) =>
      db.message.create({
        data: {
          workspaceId: ws,
          accountId: account.id,
          conversationId: conv.id,
          direction: "INBOUND",
          sentAt: new Date("2026-10-30T10:00:00Z"),
          subject: "x",
          bodyText: body,
        },
      });
    const old = await mk("We will pay on Friday.");
    const fresh = await mk("Thanks for the update.");
    const { p } = fakeProvider(() => ({ items: [], sentiment: null }));

    await expect(
      reextractSources(actor, { promptVersion: "1.0.0" }, { provider: p, clock }),
    ).rejects.toBeInstanceOf(StaleReextractError);
    await expect(
      reextractSources(actor, { promptVersion: WATCHER_PROMPT.version }, { provider: p, clock }),
    ).rejects.toBeInstanceOf(StaleReextractError);

    // The earlier version read only `old`.
    await db.agentRun.create({
      data: {
        workspaceId: ws,
        agentKey: "watcher",
        agentVersion: "1.0.0",
        promptName: "watcher-extraction",
        promptVersion: "1.0.0",
        model: "model-from-env-fast",
        modelTier: "fast",
        triggerType: "extraction",
        triggerId: `MESSAGE:${old.id}@1.0.0`,
        idempotencyKey: `old-${old.id}`,
        inputRefs: [{ sourceType: "Message", sourceId: old.id }],
        accountId: account.id,
        status: "SUCCEEDED",
        output: { items: [] },
        reasoningSummary: "r",
        confidence: 0.5,
      },
    });
    const r = await reextractSources(
      actor,
      { promptVersion: WATCHER_PROMPT.version },
      { provider: p, clock },
    );
    expect(r).toMatchObject({ notConfigured: false, sources: 1, counts: { SUCCEEDED: 1 } });
    const runs = await db.agentRun.findMany({
      where: { agentKey: "watcher", promptVersion: WATCHER_PROMPT.version },
    });
    expect(runs.map((x) => x.triggerId)).toEqual([`MESSAGE:${old.id}@${WATCHER_PROMPT.version}`]);
    expect(runs.some((x) => x.triggerId.includes(fresh.id))).toBe(false);
  });
});
