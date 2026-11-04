import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { evaluateAndStore } from "../service";

/**
 * The text rules over real records through the real lifecycle (M9 A5, Rules 1, 2, 5): verified
 * extractions on dated messages open signals with the quote as evidence; a newer prompt version
 * replaces the older one's rows; another workspace's extractions never reach this one.
 */
const ASOF = "2026-11-02";
const clock = () => new Date("2026-11-02T03:00:00Z");

async function world(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const account = await db.account.create({
    data: { workspaceId: ws, name: "Halden Retail", tier: "MID_TOUCH" },
  });
  const msg = async (channel: "TICKET" | "EMAIL", sentAt: string, body: string, subject = "x") => {
    const conv = await db.conversation.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        channel,
        subject,
        startedAt: new Date(sentAt),
        lastMessageAt: new Date(sentAt),
      },
    });
    return db.message.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        conversationId: conv.id,
        direction: "INBOUND",
        sentAt: new Date(sentAt),
        subject,
        bodyText: body,
      },
    });
  };
  const run = (version: string, triggerId: string) =>
    db.agentRun.create({
      data: {
        workspaceId: ws,
        agentKey: "watcher",
        agentVersion: version,
        promptName: "watcher-extraction",
        promptVersion: version,
        model: "m",
        modelTier: "fast",
        triggerType: "extraction",
        triggerId,
        idempotencyKey: `${triggerId}-${Math.random()}`,
        inputRefs: [{ sourceType: "Message", sourceId: "x" }],
        accountId: account.id,
        status: "SUCCEEDED",
        output: { items: [] },
        reasoningSummary: "r",
        confidence: 0.8,
      },
    });
  const extract = async (
    messageId: string,
    kind: string,
    quote: string,
    payload: Record<string, unknown> = {},
    version = "1.1.0",
    itemIndex = 0,
  ) => {
    const r = await run(version, `MESSAGE:${messageId}@${version}`);
    return db.extraction.create({
      data: {
        workspaceId: ws,
        sourceType: "MESSAGE",
        sourceId: messageId,
        accountId: account.id,
        kind: kind as never,
        quote,
        payload: payload as object,
        confidence: 0.9,
        promptVersion: version,
        itemIndex,
        chunkIndex: 0,
        agentRunId: r.id,
      },
    });
  };
  return { actor, db, ws, account, msg, extract };
}

const signalsOf = (w: Awaited<ReturnType<typeof world>>, ruleKey: string) =>
  w.db.signal.findMany({ where: { accountId: w.account.id, ruleKey } });

describe("text signals through the lifecycle", () => {
  it("opens cancel_language with the quote and the source message as evidence, and is idempotent", async () => {
    const w = await world("TextCancel");
    const m = await w.msg(
      "TICKET",
      "2026-10-30T10:00:00Z",
      "How do I export all our data before we cancel at the end of the term?",
    );
    await w.extract(m.id, "CANCEL_LANGUAGE", "before we cancel at the end of the term");
    await evaluateAndStore(w.actor, [w.account.id], ASOF, clock);
    await evaluateAndStore(w.actor, [w.account.id], ASOF, clock);
    const s = await signalsOf(w, "cancel_language");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      severity: "CRITICAL",
      status: "OPEN",
      category: "CALLS_EMAIL",
      polarity: "RISK",
    });
    expect(s[0]!.evidence).toContainEqual(
      expect.objectContaining({
        sourceType: "Message",
        sourceId: m.id,
        value: "before we cancel at the end of the term",
        date: "2026-10-30",
      }),
    );
  });

  it("Halden: the same CSV theme in three tickets opens repeat_problem and complaint_repeated", async () => {
    const w = await world("TextHalden");
    for (const [day, i] of [
      ["2026-10-12", 0],
      ["2026-10-22", 1],
      ["2026-10-31", 2],
    ] as const) {
      const m = await w.msg(
        "TICKET",
        `${day}T10:00:00Z`,
        "The CSV export failed again for us.",
        `CSV ${i}`,
      );
      await w.extract(m.id, "COMPLAINT", "The CSV export failed again for us.", {
        theme: "csv_export",
      });
    }
    await evaluateAndStore(w.actor, [w.account.id], ASOF, clock);
    expect((await signalsOf(w, "repeat_problem")).map((s) => [s.dedupeKey, s.severity])).toEqual([
      [`repeat_problem:${w.account.id}:csv_export`, "WARN"],
    ]);
    expect((await signalsOf(w, "complaint_repeated")).map((s) => s.severity)).toEqual(["WARN"]);
  });

  it("a free-text theme outside the list is `other` and never groups", async () => {
    const w = await world("TextOther");
    for (const day of ["2026-10-30", "2026-10-31"]) {
      const m = await w.msg("TICKET", `${day}T10:00:00Z`, "The thing is annoying.");
      await w.extract(m.id, "COMPLAINT", "The thing is annoying.", { theme: "the thing" });
    }
    await evaluateAndStore(w.actor, [w.account.id], ASOF, clock);
    expect(await signalsOf(w, "complaint_repeated")).toHaveLength(0);
  });

  it("a newer prompt version replaces the older rows: the old competitor mention no longer counts", async () => {
    const w = await world("TextVersions");
    const m = await w.msg("EMAIL", "2026-10-30T10:00:00Z", "We looked at Tallyfield last week.");
    await w.extract(
      m.id,
      "COMPETITOR",
      "We looked at Tallyfield",
      { competitorName: "Tallyfield" },
      "1.0.0",
    );
    await evaluateAndStore(w.actor, [w.account.id], ASOF, clock);
    expect((await signalsOf(w, "competitor_mentioned"))[0]?.status).toBe("OPEN");
    // 1.1.0 read the same message and found no competitor (a run, no rows).
    await w.db.agentRun.create({
      data: {
        workspaceId: w.ws,
        agentKey: "watcher",
        agentVersion: "1.1.0",
        promptName: "watcher-extraction",
        promptVersion: "1.1.0",
        model: "m",
        modelTier: "fast",
        triggerType: "extraction",
        triggerId: `MESSAGE:${m.id}@1.1.0`,
        idempotencyKey: `re-${m.id}`,
        inputRefs: [{ sourceType: "Message", sourceId: m.id }],
        accountId: w.account.id,
        status: "SUCCEEDED",
        output: { items: [] },
        reasoningSummary: "r",
        confidence: 0.8,
      },
    });
    await evaluateAndStore(w.actor, [w.account.id], ASOF, clock);
    expect((await signalsOf(w, "competitor_mentioned"))[0]?.status).toBe("RESOLVED");
  });

  it("an extraction dated after the as-of day is not seen (point in time)", async () => {
    const w = await world("TextFuture");
    const m = await w.msg("EMAIL", "2026-11-05T10:00:00Z", "We may cancel.");
    await w.extract(m.id, "CANCEL_LANGUAGE", "We may cancel");
    await evaluateAndStore(w.actor, [w.account.id], ASOF, clock);
    expect(await signalsOf(w, "cancel_language")).toHaveLength(0);
  });

  it("another workspace's extractions never open a signal here", async () => {
    const a = await world("TextIsoA");
    const b = await world("TextIsoB");
    const m = await b.msg("EMAIL", "2026-10-30T10:00:00Z", "We will cancel.");
    await b.extract(m.id, "CANCEL_LANGUAGE", "We will cancel");
    await evaluateAndStore(a.actor, [a.account.id], ASOF, clock);
    expect(await signalsOf(a, "cancel_language")).toHaveLength(0);
    await evaluateAndStore(b.actor, [b.account.id], ASOF, clock);
    expect(await signalsOf(b, "cancel_language")).toHaveLength(1);
  });
});
