import { describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { addExtraction } from "@/test/extraction-fixtures";
import { countQueries } from "@/test/query-counter";
import { listInbox, listUnmatched, syncInbox, receiveInboundMail } from "../service";

/**
 * /inbox's read model (M9 B1, Rule 4): rows are the triage rows plus what the source records and
 * their verified extractions say, read at display. Intent, sentiment and the sensitive flag are
 * never stored on the row.
 */
const NOW = new Date("2026-11-02T12:00:00Z");

async function world(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const mk = (name: string, domain: string) =>
    db.account.create({
      data: {
        workspaceId: ws,
        name,
        tier: "MID_TOUCH",
        domain,
        ownerMembershipId: actor.membershipId,
      },
    });
  const halden = await mk("Halden Retail", "halden.test");
  const quill = await mk("Quillmark Legal", "quillmark.test");
  const email = async (
    accountId: string,
    at: string,
    subject: string,
    body: string,
    from = "x@halden.test",
  ) => {
    const conv = await db.conversation.create({
      data: {
        workspaceId: ws,
        accountId,
        channel: "EMAIL",
        subject,
        startedAt: new Date(at),
        lastMessageAt: new Date(at),
      },
    });
    return db.message.create({
      data: {
        workspaceId: ws,
        accountId,
        conversationId: conv.id,
        direction: "INBOUND",
        sentAt: new Date(at),
        subject,
        bodyText: body,
        fromAddress: from,
      },
    });
  };
  const ticket = async (accountId: string, at: string, subject: string, body: string) => {
    const conv = await db.conversation.create({
      data: {
        workspaceId: ws,
        accountId,
        channel: "TICKET",
        subject,
        startedAt: new Date(at),
        lastMessageAt: new Date(at),
      },
    });
    const m = await db.message.create({
      data: {
        workspaceId: ws,
        accountId,
        conversationId: conv.id,
        direction: "INBOUND",
        sentAt: new Date(at),
        subject,
        bodyText: body,
      },
    });
    const t = await db.ticket.create({
      data: {
        workspaceId: ws,
        accountId,
        conversationId: conv.id,
        subject,
        openedAt: new Date(at),
      },
    });
    return { m, t };
  };
  const x = (
    accountId: string,
    sourceId: string,
    kind: Parameters<typeof addExtraction>[1]["kind"],
    quote: string,
    payload: Record<string, unknown> = {},
    itemIndex = 0,
  ) =>
    addExtraction(db, {
      workspaceId: ws,
      accountId,
      sourceType: "MESSAGE",
      sourceId,
      kind,
      quote,
      payload,
      itemIndex,
    });
  return { actor, db, ws, halden, quill, email, ticket, x };
}

describe("listInbox", () => {
  it("reads intent, sentiment and the quote from Extraction at display; nothing is copied onto the row", async () => {
    const w = await world("InboxList");
    const m = await w.email(
      w.halden.id,
      "2026-11-01T13:00:00Z",
      "CSV export failed again",
      "This is the third time the export has failed during month-end. We are losing patience.",
    );
    await w.x(
      w.halden.id,
      m.id,
      "INTENT",
      "This is the third time the export has failed",
      { intent: "complaint" },
      0,
    );
    await w.x(w.halden.id, m.id, "SENTIMENT", "We are losing patience.", { label: "NEGATIVE" }, -1);
    await syncInbox(w.actor, { now: NOW });
    const { items } = await listInbox(w.actor, {});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      account: { id: w.halden.id, name: "Halden Retail" },
      sourceType: "MESSAGE",
      title: "CSV export failed again",
      intent: "complaint",
      sentiment: { label: "NEGATIVE", quote: "We are losing patience." },
      status: "NEW",
    });
    expect(items[0]!.snippet).toContain("third time");
    const raw = await rawDb.$queryRaw<
      { column_name: string }[]
    >`SELECT column_name FROM information_schema.columns WHERE table_name = 'InboxItem'`;
    expect(raw.map((c) => c.column_name)).not.toContain("intent");
    expect(raw.map((c) => c.column_name)).not.toContain("sentimentLabel");
  });

  it("marks cancellation, export and complaint messages sensitive, with the reasons", async () => {
    const w = await world("InboxSens");
    const { m } = await w.ticket(
      w.quill.id,
      "2026-10-30T10:00:00Z",
      "Exporting our data",
      "How do I export all our data before we cancel at the end of the term?",
    );
    await w.x(w.quill.id, m.id, "CANCEL_LANGUAGE", "before we cancel at the end of the term");
    await w.x(
      w.quill.id,
      m.id,
      "INTENT",
      "How do I export all our data before we cancel",
      { intent: "cancellation" },
      1,
    );
    await syncInbox(w.actor, { now: NOW });
    const { items } = await listInbox(w.actor, {});
    expect(items[0]).toMatchObject({ sourceType: "TICKET", intent: "cancellation" });
    expect(items[0]!.sensitive).toEqual({ isSensitive: true, reasons: ["cancellation"] });
  });

  it("links the other tickets with the same theme (Halden's three CSV tickets)", async () => {
    const w = await world("InboxRelated");
    const ids: string[] = [];
    for (const [d, i] of [
      ["2026-10-12", 0],
      ["2026-10-22", 1],
      ["2026-10-31", 2],
    ] as const) {
      const { m, t } = await w.ticket(
        w.halden.id,
        `${d}T10:00:00Z`,
        `CSV export fails ${i}`,
        "The CSV export fails.",
      );
      ids.push(t.id);
      await w.x(w.halden.id, m.id, "THEME", "The CSV export fails.", { theme: "csv_export" });
    }
    const email = await w.email(
      w.halden.id,
      "2026-11-01T13:00:00Z",
      "CSV export failed again",
      "The export failed again.",
    );
    await w.x(w.halden.id, email.id, "COMPLAINT", "The export failed again.", {
      theme: "csv_export",
    });
    await syncInbox(w.actor, { now: NOW });
    const { items } = await listInbox(w.actor, {});
    const row = items.find((i) => i.sourceType === "MESSAGE")!;
    expect(row.theme).toBe("csv_export");
    expect(row.relatedTickets.map((t) => t.id).sort()).toEqual([...ids].sort());
    expect(row.relatedTickets[0]).toHaveProperty("subject");
    const ticketRow = items.find((i) => i.sourceType === "TICKET")!;
    expect(ticketRow.relatedTickets.map((t) => t.id)).not.toContain(ticketRow.sourceId);
  });

  it("pages by cursor, newest first, with no gaps or repeats", async () => {
    const w = await world("InboxPage");
    for (let i = 0; i < 7; i++)
      await w.email(w.halden.id, `2026-10-${10 + i}T10:00:00Z`, `Subject ${i}`, "body");
    await syncInbox(w.actor, { now: NOW });
    const a = await listInbox(w.actor, {}, 3);
    const b = await listInbox(w.actor, { cursor: a.nextCursor! }, 3);
    const c = await listInbox(w.actor, { cursor: b.nextCursor! }, 3);
    expect([a.items.length, b.items.length, c.items.length]).toEqual([3, 3, 1]);
    expect(c.nextCursor).toBeNull();
    const titles = [...a.items, ...b.items, ...c.items].map((i) => i.title);
    expect(titles).toEqual([
      "Subject 6",
      "Subject 5",
      "Subject 4",
      "Subject 3",
      "Subject 2",
      "Subject 1",
      "Subject 0",
    ]);
  });

  it("filters to open items by default and shows everything with status ALL", async () => {
    const w = await world("InboxStatus");
    await w.email(w.halden.id, "2026-10-30T10:00:00Z", "Open one", "q");
    await w.email(w.halden.id, "2026-10-31T10:00:00Z", "Closed one", "q");
    await syncInbox(w.actor, { now: NOW });
    await w.db.inboxItem.updateMany({
      where: { receivedAt: new Date("2026-10-31T10:00:00Z") },
      data: { status: "CLOSED" },
    });
    expect((await listInbox(w.actor, {})).items.map((i) => i.title)).toEqual(["Open one"]);
    expect((await listInbox(w.actor, { status: "ALL" })).items).toHaveLength(2);
  });

  it("a CSM sees only their book; another workspace's items never appear", async () => {
    const w = await world("InboxBook");
    const other = await w.db.account.create({
      data: { workspaceId: w.ws, name: "Not mine", tier: "MID_TOUCH", domain: "nm.test" },
    });
    await w.email(w.halden.id, "2026-10-30T10:00:00Z", "Mine", "q");
    await w.email(other.id, "2026-10-30T11:00:00Z", "Not mine", "q");
    await syncInbox(w.actor, { now: NOW });
    const csm = { ...w.actor, role: "CSM" as const, bookScope: "OWN" as const };
    expect((await listInbox(csm, {})).items.map((i) => i.title)).toEqual(["Mine"]);
    expect((await listInbox(w.actor, {})).items).toHaveLength(2);
    const stranger = await world("InboxStranger");
    expect((await listInbox(stranger.actor, {})).items).toHaveLength(0);
  });

  it("reads a fixed number of times for 2 accounts and for 5 (no N+1)", async () => {
    const w = await world("InboxBudget");
    const accounts = [w.halden, w.quill];
    for (const a of accounts) {
      const m = await w.email(a.id, "2026-10-30T10:00:00Z", "S", "body");
      await w.x(a.id, m.id, "INTENT", "body", { intent: "question" });
    }
    await syncInbox(w.actor, { now: NOW });
    const two = await countQueries(() => listInbox(w.actor, {}));
    for (let i = 0; i < 3; i++) {
      const a = await w.db.account.create({
        data: {
          workspaceId: w.ws,
          name: `Extra ${i}`,
          tier: "MID_TOUCH",
          ownerMembershipId: w.actor.membershipId,
        },
      });
      const m = await w.email(a.id, "2026-10-30T10:00:00Z", "S", "body");
      await w.x(a.id, m.id, "INTENT", "body", { intent: "question" });
      const t = await w.ticket(a.id, "2026-10-29T10:00:00Z", "T", "tbody");
      await w.x(a.id, t.m.id, "THEME", "tbody", { theme: "billing" });
    }
    await syncInbox(w.actor, { now: NOW });
    const five = await countQueries(() => listInbox(w.actor, {}));
    expect(five.result.items.length).toBeGreaterThan(two.result.items.length);
    expect(five.queries).toBe(two.queries);
  });
});

describe("listUnmatched", () => {
  it("lists pending mail with its reason and the candidate account names, oldest decision first", async () => {
    const w = await world("InboxUnm");
    await w.db.account.updateMany({ data: { domain: "twin.test" } });
    await receiveInboundMail(w.actor, {
      provider: "GMAIL",
      externalId: "u1",
      from: "a@twin.test",
      to: [],
      subject: "Hello",
      bodyText: "hi there",
      receivedAt: new Date("2026-11-01T10:00:00Z"),
    });
    await receiveInboundMail(w.actor, {
      provider: "GMAIL",
      externalId: "u2",
      from: "a@nowhere.test",
      to: [],
      subject: "Other",
      bodyText: "yo",
      receivedAt: new Date("2026-11-02T10:00:00Z"),
    });
    const rows = await listUnmatched(w.actor);
    expect(rows.map((r) => r.subject)).toEqual(["Other", "Hello"]);
    expect(rows[1]!.candidates.map((c) => c.name).sort()).toEqual([
      "Halden Retail",
      "Quillmark Legal",
    ]);
    expect(rows[1]!.reason).toMatch(/2 accounts share twin\.test/);
    expect(rows[0]!.candidates).toEqual([]);
  });
});
