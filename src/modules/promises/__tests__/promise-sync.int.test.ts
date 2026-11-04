import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { currentExtractions } from "@/modules/conversations/service";
import { syncSignalRules } from "@/modules/signals/service";
import { markPromiseKept, syncPromises } from "../service";

/**
 * The Promise engine over real records (M9 A4, Rules 1, 2, 4): PROMISE extractions become Promise
 * rows (deduped on source + quote), GOAL extractions become AI-origin Goals, and status is
 * recomputed by code. Extraction rows are built directly here (A3 covers how the Watcher writes
 * them); the point is what the records become.
 */
const TODAY = "2026-11-02";

async function world(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const account = await db.account.create({
    data: { workspaceId: ws, name: "Halden Retail", tier: "MID_TOUCH" },
  });
  const other = await db.account.create({
    data: { workspaceId: ws, name: "Other Co", tier: "MID_TOUCH" },
  });
  const dora = await db.contact.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      name: "Dora Lindqvist",
      email: "dora@halden.test",
    },
  });
  const conv = await db.conversation.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      channel: "TICKET",
      subject: "Export",
      startedAt: new Date("2026-10-20"),
      lastMessageAt: new Date("2026-10-20"),
    },
  });
  const run = async (version: string, triggerId: string) =>
    db.agentRun.create({
      data: {
        workspaceId: ws,
        agentKey: "watcher",
        agentVersion: version,
        promptName: "watcher-extraction",
        promptVersion: version,
        model: "model-from-env-fast",
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
  const extract = async (o: {
    sourceType: "MESSAGE" | "CALL_TRANSCRIPT" | "NOTE";
    sourceId: string;
    kind: "PROMISE" | "GOAL";
    quote: string;
    payload: Record<string, unknown>;
    version?: string;
    itemIndex?: number;
    flags?: string[];
    accountId?: string;
  }) => {
    const version = o.version ?? "1.1.0";
    const r = await run(version, `${o.sourceType}:${o.sourceId}@${version}`);
    return db.extraction.create({
      data: {
        workspaceId: ws,
        sourceType: o.sourceType,
        sourceId: o.sourceId,
        accountId: o.accountId ?? account.id,
        kind: o.kind,
        quote: o.quote,
        payload: o.payload as object,
        confidence: 0.9,
        promptVersion: version,
        itemIndex: o.itemIndex ?? 0,
        chunkIndex: 0,
        flags: o.flags ?? [],
        agentRunId: r.id,
      },
    });
  };
  return { actor, db, ws, account, other, dora, conv, extract };
}

describe("syncPromises: PROMISE extractions become Promise rows", () => {
  it("creates one promise per promise, with its quote, source, party, date and a computed status", async () => {
    const w = await world("PromiseSync");
    const call = await w.db.callTranscript.create({
      data: {
        workspaceId: w.ws,
        conversationId: w.conv.id,
        accountId: w.account.id,
        title: "Export follow-up",
        provider: "seed",
        occurredAt: new Date("2026-10-02"),
        text: `Title: Export follow-up\nDate: 2026-10-02\n\nPromiseSync Admin: Engineering will have the CSV export fix to you by October 24.\nDora Lindqvist: We will send the order form once it is fixed.\n`,
      },
    });
    const a = await w.extract({
      sourceType: "CALL_TRANSCRIPT",
      sourceId: call.id,
      kind: "PROMISE",
      quote: "Engineering will have the CSV export fix to you by October 24.",
      payload: { what: "CSV export fix", dueDate: "2026-10-24" },
    });
    await w.extract({
      sourceType: "CALL_TRANSCRIPT",
      sourceId: call.id,
      kind: "PROMISE",
      itemIndex: 1,
      quote: "We will send the order form once it is fixed.",
      payload: { what: "Send the order form", dueDate: null },
      flags: ["no_date"],
    });

    const r = await syncPromises(w.actor, { today: TODAY });
    expect(r.promisesCreated).toBe(2);

    const rows = await w.db.promise.findMany({ orderBy: { createdAt: "asc" } });
    const fix = rows.find((p) => p.what === "CSV export fix")!;
    expect(fix).toMatchObject({
      party: "US",
      status: "LATE",
      origin: "AI",
      sourceType: "CALL_TRANSCRIPT",
      sourceId: call.id,
      quote: "Engineering will have the CSV export fix to you by October 24.",
      extractionId: a.id,
      ownerMembershipId: null,
    });
    expect(fix.dueDate?.toISOString().slice(0, 10)).toBe("2026-10-24");
    expect(fix.statusReason).toMatch(/9 days late/);
    expect(fix.agentRunId).toBe(a.agentRunId);
    const order = rows.find((p) => p.what === "Send the order form")!;
    expect(order).toMatchObject({ party: "CUSTOMER", status: "OPEN", dueDate: null });
  });

  it("is idempotent, and a newer prompt version re-reading the same quote adds nothing", async () => {
    const w = await world("PromiseIdem");
    const m = await w.db.message.create({
      data: {
        workspaceId: w.ws,
        accountId: w.account.id,
        conversationId: w.conv.id,
        direction: "OUTBOUND",
        sentAt: new Date("2026-10-20T10:00:00Z"),
        bodyText: "I'll send the guide by Friday 6 November.",
      },
    });
    const q = "I'll send the guide by Friday 6 November.";
    await w.extract({
      sourceType: "MESSAGE",
      sourceId: m.id,
      kind: "PROMISE",
      quote: q,
      payload: { what: "Guide", dueDate: "2026-11-06" },
    });
    expect((await syncPromises(w.actor, { today: TODAY })).promisesCreated).toBe(1);
    expect((await syncPromises(w.actor, { today: TODAY })).promisesCreated).toBe(0);
    await w.extract({
      sourceType: "MESSAGE",
      sourceId: m.id,
      kind: "PROMISE",
      quote: q,
      payload: { what: "Guide", dueDate: "2026-11-06" },
      version: "1.2.0",
    });
    expect((await syncPromises(w.actor, { today: TODAY })).promisesCreated).toBe(0);
    expect(await w.db.promise.count()).toBe(1);
    expect((await w.db.promise.findFirstOrThrow()).party).toBe("US"); // outbound message
  });

  it("an unclear speaker is not guessed: party UNCLEAR, the model's hint kept only as a suggestion", async () => {
    const w = await world("PromiseUnclear");
    const call = await w.db.callTranscript.create({
      data: {
        workspaceId: w.ws,
        conversationId: w.conv.id,
        accountId: w.account.id,
        title: "t",
        provider: "seed",
        occurredAt: new Date("2026-10-02"),
        text: "Title: t\nDate: 2026-10-02\n\nPat Quinn: We will look into the export problem.\n",
      },
    });
    await w.extract({
      sourceType: "CALL_TRANSCRIPT",
      sourceId: call.id,
      kind: "PROMISE",
      quote: "We will look into the export problem.",
      payload: { what: "Look into export", dueDate: null, party: "customer" },
    });
    await syncPromises(w.actor, { today: TODAY });
    expect(await w.db.promise.findFirstOrThrow()).toMatchObject({
      party: "UNCLEAR",
      suggestedParty: "CUSTOMER",
    });
  });

  it("never reads another account's or workspace's promise: an extraction on account B stays on B", async () => {
    const w = await world("PromiseAcct");
    await w.extract({
      sourceType: "NOTE",
      sourceId: "n1",
      kind: "PROMISE",
      quote: "We will send it",
      payload: { what: "Send it", dueDate: null },
      accountId: w.other.id,
    });
    await syncPromises(w.actor, { today: TODAY });
    const p = await w.db.promise.findFirstOrThrow();
    expect(p.accountId).toBe(w.other.id);
  });
});

describe("syncPromises: status by code, evidence by records", () => {
  it("a US promise made in a ticket thread is kept when that ticket closes after it; a customer promise never is", async () => {
    const w = await world("PromiseKept");
    const ours = await w.db.message.create({
      data: {
        workspaceId: w.ws,
        accountId: w.account.id,
        conversationId: w.conv.id,
        direction: "OUTBOUND",
        sentAt: new Date("2026-10-20T10:00:00Z"),
        bodyText: "We will fix the export this week.",
      },
    });
    const theirs = await w.db.message.create({
      data: {
        workspaceId: w.ws,
        accountId: w.account.id,
        conversationId: w.conv.id,
        direction: "INBOUND",
        sentAt: new Date("2026-10-20T11:00:00Z"),
        bodyText: "We will send you the logs tomorrow.",
      },
    });
    const ticket = await w.db.ticket.create({
      data: {
        workspaceId: w.ws,
        accountId: w.account.id,
        conversationId: w.conv.id,
        subject: "Export",
        status: "CLOSED",
        openedAt: new Date("2026-10-19"),
        closedAt: new Date("2026-10-28T09:00:00Z"),
      },
    });
    await w.extract({
      sourceType: "MESSAGE",
      sourceId: ours.id,
      kind: "PROMISE",
      quote: "We will fix the export this week.",
      payload: { what: "Fix export", dueDate: null },
    });
    await w.extract({
      sourceType: "MESSAGE",
      sourceId: theirs.id,
      kind: "PROMISE",
      quote: "We will send you the logs tomorrow.",
      payload: { what: "Send logs", dueDate: null },
    });
    await syncPromises(w.actor, { today: TODAY });
    const kept = await w.db.promise.findFirstOrThrow({ where: { what: "Fix export" } });
    expect(kept).toMatchObject({ status: "KEPT", evidenceType: "Ticket", evidenceId: ticket.id });
    expect((await w.db.promise.findFirstOrThrow({ where: { what: "Send logs" } })).status).toBe(
      "OPEN",
    );
  });

  it("a ticket that closed BEFORE the promise was made is not evidence", async () => {
    const w = await world("PromiseBefore");
    const msg = await w.db.message.create({
      data: {
        workspaceId: w.ws,
        accountId: w.account.id,
        conversationId: w.conv.id,
        direction: "OUTBOUND",
        sentAt: new Date("2026-10-25T10:00:00Z"),
        bodyText: "We will fix it by 2026-10-27.",
      },
    });
    await w.db.ticket.create({
      data: {
        workspaceId: w.ws,
        accountId: w.account.id,
        conversationId: w.conv.id,
        subject: "Old",
        status: "CLOSED",
        openedAt: new Date("2026-10-01"),
        closedAt: new Date("2026-10-10T09:00:00Z"),
      },
    });
    await w.extract({
      sourceType: "MESSAGE",
      sourceId: msg.id,
      kind: "PROMISE",
      quote: "We will fix it by 2026-10-27.",
      payload: { what: "Fix", dueDate: "2026-10-27" },
    });
    await syncPromises(w.actor, { today: TODAY });
    expect((await w.db.promise.findFirstOrThrow()).status).toBe("LATE");
  });

  it("a person marks it kept with a record in the same account; a record from another account is refused; audited", async () => {
    const w = await world("PromiseMark");
    const msg = await w.db.message.create({
      data: {
        workspaceId: w.ws,
        accountId: w.account.id,
        conversationId: w.conv.id,
        direction: "OUTBOUND",
        sentAt: new Date("2026-10-20T10:00:00Z"),
        bodyText: "I'll send the report by 2026-10-24.",
      },
    });
    await w.extract({
      sourceType: "MESSAGE",
      sourceId: msg.id,
      kind: "PROMISE",
      quote: "I'll send the report by 2026-10-24.",
      payload: { what: "Report", dueDate: "2026-10-24" },
    });
    await syncPromises(w.actor, { today: TODAY });
    const p = await w.db.promise.findFirstOrThrow();
    expect(p.status).toBe("LATE");

    const otherConv = await w.db.conversation.create({
      data: {
        workspaceId: w.ws,
        accountId: w.other.id,
        channel: "TICKET",
        subject: "x",
        startedAt: new Date("2026-10-20"),
        lastMessageAt: new Date("2026-10-20"),
      },
    });
    const foreign = await w.db.ticket.create({
      data: {
        workspaceId: w.ws,
        accountId: w.other.id,
        conversationId: otherConv.id,
        subject: "Else",
        status: "CLOSED",
        openedAt: new Date("2026-10-20"),
        closedAt: new Date("2026-10-30"),
      },
    });
    await expect(
      markPromiseKept(w.actor, {
        promiseId: p.id,
        evidence: { type: "Ticket", id: foreign.id },
        today: TODAY,
      }),
    ).rejects.toThrow(/not on this account/i);

    const mine = await w.db.note.create({
      data: {
        workspaceId: w.ws,
        accountId: w.account.id,
        authorMembershipId: w.actor.membershipId,
        body: "Sent the report on the 29th.",
      },
    });
    await markPromiseKept(w.actor, {
      promiseId: p.id,
      evidence: { type: "Note", id: mine.id },
      today: TODAY,
    });
    const kept = await w.db.promise.findUniqueOrThrow({ where: { id: p.id } });
    expect(kept).toMatchObject({ status: "KEPT", evidenceType: "Note", evidenceId: mine.id });
    expect(kept.keptAt).not.toBeNull();
    const audit = await w.db.auditLog.findFirst({
      where: { action: "promise.kept", targetId: p.id },
    });
    expect(audit?.actorId).toBe(w.actor.userId);

    // Re-syncing keeps it kept (status comes from the stored evidence).
    await syncPromises(w.actor, { today: "2026-12-30" });
    expect((await w.db.promise.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("KEPT");
  });

  it("uses promise_late's brokenAfterDays setting when the workspace has edited it", async () => {
    const w = await world("PromiseBroken");
    const msg = await w.db.message.create({
      data: {
        workspaceId: w.ws,
        accountId: w.account.id,
        conversationId: w.conv.id,
        direction: "OUTBOUND",
        sentAt: new Date("2026-10-20T10:00:00Z"),
        bodyText: "We will ship by 2026-10-24.",
      },
    });
    await w.extract({
      sourceType: "MESSAGE",
      sourceId: msg.id,
      kind: "PROMISE",
      quote: "We will ship by 2026-10-24.",
      payload: { what: "Ship", dueDate: "2026-10-24" },
    });
    await syncPromises(w.actor, { today: TODAY });
    expect((await w.db.promise.findFirstOrThrow()).status).toBe("LATE"); // 9 days, default 14
    await syncSignalRules(w.actor);
    await w.db.signalRule.updateMany({
      where: { ruleKey: "promise_late" },
      data: { params: { brokenAfterDays: 7 } },
    });
    await syncPromises(w.actor, { today: TODAY });
    expect((await w.db.promise.findFirstOrThrow()).status).toBe("BROKEN");
  });
});

describe("syncPromises: GOAL extractions become AI-origin Goals", () => {
  it("creates a goal with its quote, source, extraction and run, once", async () => {
    const w = await world("PromiseGoal");
    const call = await w.db.callTranscript.create({
      data: {
        workspaceId: w.ws,
        conversationId: w.conv.id,
        accountId: w.account.id,
        title: "Kickoff",
        provider: "seed",
        occurredAt: new Date("2026-10-08"),
        text: "Title: Kickoff\nDate: 2026-10-08\n\nAnya Finch: Our goal is to cut month-end close to 3 days.\n",
      },
    });
    const e = await w.extract({
      sourceType: "CALL_TRANSCRIPT",
      sourceId: call.id,
      kind: "GOAL",
      quote: "Our goal is to cut month-end close to 3 days.",
      payload: { goal: "Cut month-end close to 3 days" },
    });
    const r = await syncPromises(w.actor, { today: TODAY });
    expect(r.goalsCreated).toBe(1);
    expect(await w.db.goal.findFirstOrThrow({ where: { extractionId: e.id } })).toMatchObject({
      text: "Cut month-end close to 3 days",
      origin: "AI",
      agentRunId: e.agentRunId,
      sourceType: "CALL_TRANSCRIPT",
      sourceId: call.id,
      quote: "Our goal is to cut month-end close to 3 days.",
      metricKey: null,
      targetValue: null,
      status: "OPEN",
    });
    expect((await syncPromises(w.actor, { today: TODAY })).goalsCreated).toBe(0);
    expect(await w.db.goal.count()).toBe(1);
  });
});

describe("currentExtractions: the latest prompt version per source wins", () => {
  it("rows of an older version are ignored once a newer version has read the source, even if it found nothing", async () => {
    const w = await world("PromiseLatest");
    await w.extract({
      sourceType: "NOTE",
      sourceId: "n-old",
      kind: "PROMISE",
      quote: "We will do A",
      payload: { what: "A", dueDate: null },
      version: "1.0.0",
    });
    // 1.1.0 read the same note and found nothing: only its run exists.
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
        triggerId: "NOTE:n-old@1.1.0",
        idempotencyKey: "k-n-old-110",
        inputRefs: [{ sourceType: "Note", sourceId: "n-old" }],
        accountId: w.account.id,
        status: "SUCCEEDED",
        output: { items: [] },
        reasoningSummary: "r",
        confidence: 0.8,
      },
    });
    await w.extract({
      sourceType: "NOTE",
      sourceId: "n-keep",
      kind: "PROMISE",
      quote: "We will do B",
      payload: { what: "B", dueDate: null },
      version: "1.0.0",
    });
    const rows = await currentExtractions(w.db, { kinds: ["PROMISE"] });
    expect(rows.map((r) => r.quote)).toEqual(["We will do B"]);
  });
});
