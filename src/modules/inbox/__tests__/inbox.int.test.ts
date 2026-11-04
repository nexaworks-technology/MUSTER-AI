import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { countQueries } from "@/test/query-counter";
import { assignUnmatched, dismissUnmatched, receiveInboundMail, syncInbox } from "../service";

/**
 * The inbox over real records (M9 A7, Rules 2, 4): inbound mail lands on exactly one account or in
 * the Unmatched queue, never a guess; the queue's text lives in one place and is cleared on a
 * person's decision; the inbox view is built from the messages and tickets that already exist.
 */
const NOW = new Date("2026-11-02T12:00:00Z");

async function world(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const halden = await db.account.create({
    data: { workspaceId: ws, name: "Halden Retail", tier: "MID_TOUCH", domain: "halden.test" },
  });
  const twinA = await db.account.create({
    data: { workspaceId: ws, name: "Twin A", tier: "MID_TOUCH", domain: "twin.test" },
  });
  const twinB = await db.account.create({
    data: { workspaceId: ws, name: "Twin B", tier: "MID_TOUCH", domain: "twin.test" },
  });
  const dora = await db.contact.create({
    data: {
      workspaceId: ws,
      accountId: halden.id,
      name: "Dora Lindqvist",
      email: "dora@halden.test",
    },
  });
  return { actor, db, ws, halden, twinA, twinB, dora };
}
const mail = (over: Partial<Parameters<typeof receiveInboundMail>[1]> = {}) => ({
  provider: "GMAIL" as const,
  externalId: `ext-${Math.random()}`,
  from: "dora@halden.test",
  to: ["leo@us.test"],
  subject: "Export",
  bodyText: "The CSV export failed again.",
  receivedAt: new Date("2026-11-02T09:00:00Z"),
  ...over,
});

describe("receiveInboundMail", () => {
  it("an exact contact match creates a conversation, an inbound message from that contact and an inbox item", async () => {
    const w = await world("InboxExact");
    const r = await receiveInboundMail(w.actor, mail({ externalId: "g-1" }));
    expect(r).toMatchObject({ outcome: "MATCHED", accountId: w.halden.id });
    const msg = await w.db.message.findFirstOrThrow({ where: { accountId: w.halden.id } });
    expect(msg).toMatchObject({
      direction: "INBOUND",
      fromContactId: w.dora.id,
      fromAddress: "dora@halden.test",
      source: "GMAIL",
    });
    const item = await w.db.inboxItem.findFirstOrThrow();
    expect(item).toMatchObject({
      accountId: w.halden.id,
      sourceType: "MESSAGE",
      sourceId: msg.id,
      status: "NEW",
      matchedBy: "CONTACT_EMAIL",
    });
    expect(await w.db.unmatchedInbound.count()).toBe(0);
  });

  it("a domain match with one account is matched by DOMAIN, with no contact", async () => {
    const w = await world("InboxDomain");
    await receiveInboundMail(w.actor, mail({ externalId: "g-2", from: "newperson@halden.test" }));
    const msg = await w.db.message.findFirstOrThrow();
    expect(msg.fromContactId).toBeNull();
    expect((await w.db.inboxItem.findFirstOrThrow()).matchedBy).toBe("DOMAIN");
  });

  it("a domain shared by two accounts goes to Unmatched and creates nothing else", async () => {
    const w = await world("InboxShared");
    const r = await receiveInboundMail(w.actor, mail({ externalId: "g-3", from: "x@twin.test" }));
    expect(r).toMatchObject({ outcome: "UNMATCHED" });
    const u = await w.db.unmatchedInbound.findFirstOrThrow();
    expect(u.status).toBe("PENDING");
    expect(u.candidateAccountIds.sort()).toEqual([w.twinA.id, w.twinB.id].sort());
    expect(u.reason).toMatch(/2 accounts share twin\.test/);
    expect(u.bodyText).toBe("The CSV export failed again.");
    expect(await w.db.message.count()).toBe(0);
    expect(await w.db.inboxItem.count()).toBe(0);
  });

  it("a free-mail sender and an unknown domain are unmatched", async () => {
    const w = await world("InboxFree");
    await receiveInboundMail(w.actor, mail({ externalId: "g-4", from: "someone@gmail.com" }));
    await receiveInboundMail(w.actor, mail({ externalId: "g-5", from: "x@nowhere.test" }));
    expect(await w.db.unmatchedInbound.count()).toBe(2);
    expect(await w.db.message.count()).toBe(0);
  });

  it("is idempotent per provider message: a re-delivery changes nothing", async () => {
    const w = await world("InboxIdem");
    const m = mail({ externalId: "g-6" });
    await receiveInboundMail(w.actor, m);
    expect(await receiveInboundMail(w.actor, m)).toMatchObject({ outcome: "DUPLICATE" });
    const u = mail({ externalId: "g-7", from: "x@twin.test" });
    await receiveInboundMail(w.actor, u);
    expect(await receiveInboundMail(w.actor, u)).toMatchObject({ outcome: "DUPLICATE" });
    expect(await w.db.message.count()).toBe(1);
    expect(await w.db.unmatchedInbound.count()).toBe(1);
  });

  it("replies join the existing thread by the provider's thread id", async () => {
    const w = await world("InboxThread");
    await receiveInboundMail(w.actor, mail({ externalId: "g-8", threadId: "th-1" }));
    await receiveInboundMail(
      w.actor,
      mail({ externalId: "g-9", threadId: "th-1", receivedAt: new Date("2026-11-02T10:00:00Z") }),
    );
    expect(await w.db.conversation.count()).toBe(1);
    expect(await w.db.message.count()).toBe(2);
  });

  it("never matches across workspaces: the same sender in two workspaces lands only in its own", async () => {
    const a = await world("InboxIsoA");
    const b = await world("InboxIsoB");
    await receiveInboundMail(a.actor, mail({ externalId: "g-10" }));
    expect(await a.db.message.count()).toBe(1);
    expect(await b.db.message.count()).toBe(0);
    const stray = await receiveInboundMail(
      b.actor,
      mail({ externalId: "g-10", from: "dora@halden.test" }),
    );
    expect(stray).toMatchObject({ outcome: "MATCHED", accountId: b.halden.id });
    expect(await a.db.message.count()).toBe(1);
  });

  it("a bounce notice marks the contact BOUNCED, adds no inbox item, and the database stamps the date", async () => {
    const w = await world("InboxBounce");
    const r = await receiveInboundMail(
      w.actor,
      mail({
        externalId: "g-11",
        from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
        subject: "Delivery Status Notification (Failure)",
        bodyText:
          "Your message wasn't delivered to dora@halden.test because the address couldn't be found.",
      }),
    );
    expect(r).toMatchObject({ outcome: "BOUNCE", contactId: w.dora.id });
    const c = await w.db.contact.findUniqueOrThrow({ where: { id: w.dora.id } });
    expect(c.status).toBe("BOUNCED");
    expect(c.statusChangedAt).not.toBeNull();
    expect(await w.db.inboxItem.count()).toBe(0);
    expect(await w.db.unmatchedInbound.count()).toBe(0);
  });
});

describe("Unmatched queue decisions", () => {
  it("assigning moves the text into a conversation and message, clears the holding copy, creates the item and audits", async () => {
    const w = await world("InboxAssign");
    await receiveInboundMail(w.actor, mail({ externalId: "g-12", from: "x@twin.test" }));
    const u = await w.db.unmatchedInbound.findFirstOrThrow();
    await assignUnmatched(w.actor, { id: u.id, accountId: w.twinB.id });
    const after = await w.db.unmatchedInbound.findUniqueOrThrow({ where: { id: u.id } });
    expect(after).toMatchObject({
      status: "ASSIGNED",
      bodyText: null,
      assignedAccountId: w.twinB.id,
      decidedByMembershipId: w.actor.membershipId,
    });
    const msg = await w.db.message.findFirstOrThrow({ where: { accountId: w.twinB.id } });
    expect(msg).toMatchObject({
      direction: "INBOUND",
      bodyText: "The CSV export failed again.",
      fromAddress: "x@twin.test",
    });
    expect(await w.db.inboxItem.findFirstOrThrow({ where: { sourceId: msg.id } })).toMatchObject({
      matchedBy: "MANUAL",
      accountId: w.twinB.id,
    });
    const audit = await w.db.auditLog.findFirst({
      where: { action: "inbox.unmatched_assigned", targetId: u.id },
    });
    expect(audit?.actorId).toBe(w.actor.userId);
    // A re-delivery of the same provider message is still a duplicate, not a second copy.
    expect(
      await receiveInboundMail(w.actor, mail({ externalId: "g-12", from: "x@twin.test" })),
    ).toMatchObject({ outcome: "DUPLICATE" });
  });

  it("assigning twice, or to an account that is not in this workspace, is refused", async () => {
    const a = await world("InboxAssignA");
    const b = await world("InboxAssignB");
    await receiveInboundMail(a.actor, mail({ externalId: "g-13", from: "x@twin.test" }));
    const u = await a.db.unmatchedInbound.findFirstOrThrow();
    await expect(assignUnmatched(a.actor, { id: u.id, accountId: b.halden.id })).rejects.toThrow(
      /account/i,
    );
    await assignUnmatched(a.actor, { id: u.id, accountId: a.twinA.id });
    await expect(assignUnmatched(a.actor, { id: u.id, accountId: a.twinA.id })).rejects.toThrow(
      /already/i,
    );
  });

  it("dismissing clears the text and audits; the row stays as a record", async () => {
    const w = await world("InboxDismiss");
    await receiveInboundMail(w.actor, mail({ externalId: "g-14", from: "x@nowhere.test" }));
    const u = await w.db.unmatchedInbound.findFirstOrThrow();
    await dismissUnmatched(w.actor, { id: u.id });
    expect(await w.db.unmatchedInbound.findUniqueOrThrow({ where: { id: u.id } })).toMatchObject({
      status: "DISMISSED",
      bodyText: null,
    });
    expect(
      await w.db.auditLog.count({ where: { action: "inbox.unmatched_dismissed", targetId: u.id } }),
    ).toBe(1);
  });
});

describe("syncInbox: the inbox is a view of existing records", () => {
  it("makes items for inbound emails and tickets, none for tickets' messages, our own messages or calls", async () => {
    const w = await world("InboxSync");
    const conv = (channel: "EMAIL" | "TICKET" | "CALL", at: string) =>
      w.db.conversation.create({
        data: {
          workspaceId: w.ws,
          accountId: w.halden.id,
          channel,
          subject: "s",
          startedAt: new Date(at),
          lastMessageAt: new Date(at),
        },
      });
    const m = async (conversationId: string, direction: "INBOUND" | "OUTBOUND", at: string) =>
      w.db.message.create({
        data: {
          workspaceId: w.ws,
          accountId: w.halden.id,
          conversationId,
          direction,
          sentAt: new Date(at),
          subject: "s",
          bodyText: "text",
        },
      });
    const email = await conv("EMAIL", "2026-10-30T10:00:00Z");
    const inboundEmail = await m(email.id, "INBOUND", "2026-10-30T10:00:00Z");
    const tconv = await conv("TICKET", "2026-10-28T10:00:00Z");
    await m(tconv.id, "INBOUND", "2026-10-28T10:00:00Z");
    const ticket = await w.db.ticket.create({
      data: {
        workspaceId: w.ws,
        accountId: w.halden.id,
        conversationId: tconv.id,
        subject: "CSV export",
        openedAt: new Date("2026-10-28T10:00:00Z"),
      },
    });
    const call = await conv("CALL", "2026-10-29T10:00:00Z");
    await m(call.id, "INBOUND", "2026-10-29T10:00:00Z");
    const out = await conv("EMAIL", "2026-10-30T11:00:00Z");
    await m(out.id, "OUTBOUND", "2026-10-30T11:00:00Z");

    const r = await syncInbox(w.actor, { now: NOW });
    expect(r.created).toBe(2);
    const items = await w.db.inboxItem.findMany({ orderBy: { receivedAt: "asc" } });
    expect(items.map((i) => [i.sourceType, i.sourceId, i.matchedBy, i.status])).toEqual([
      ["TICKET", ticket.id, "SOURCE", "NEW"],
      ["MESSAGE", inboundEmail.id, "SOURCE", "NEW"],
    ]);
    expect((await syncInbox(w.actor, { now: NOW })).created).toBe(0);
  });

  it("advances status from the records: a later reply is REPLIED, a closed ticket CLOSED; never backwards", async () => {
    const w = await world("InboxStatus");
    const conv = await w.db.conversation.create({
      data: {
        workspaceId: w.ws,
        accountId: w.halden.id,
        channel: "EMAIL",
        subject: "s",
        startedAt: new Date("2026-10-30"),
        lastMessageAt: new Date("2026-10-30"),
      },
    });
    const inbound = await w.db.message.create({
      data: {
        workspaceId: w.ws,
        accountId: w.halden.id,
        conversationId: conv.id,
        direction: "INBOUND",
        sentAt: new Date("2026-10-30T10:00:00Z"),
        subject: "s",
        bodyText: "q?",
      },
    });
    await syncInbox(w.actor, { now: NOW });
    expect((await w.db.inboxItem.findFirstOrThrow()).status).toBe("NEW");
    await w.db.message.create({
      data: {
        workspaceId: w.ws,
        accountId: w.halden.id,
        conversationId: conv.id,
        direction: "OUTBOUND",
        sentAt: new Date("2026-10-30T15:00:00Z"),
        subject: "s",
        bodyText: "a",
      },
    });
    await syncInbox(w.actor, { now: NOW });
    expect(
      (await w.db.inboxItem.findFirstOrThrow({ where: { sourceId: inbound.id } })).status,
    ).toBe("REPLIED");

    const tconv = await w.db.conversation.create({
      data: {
        workspaceId: w.ws,
        accountId: w.halden.id,
        channel: "TICKET",
        subject: "t",
        startedAt: new Date("2026-10-20"),
        lastMessageAt: new Date("2026-10-20"),
      },
    });
    const t = await w.db.ticket.create({
      data: {
        workspaceId: w.ws,
        accountId: w.halden.id,
        conversationId: tconv.id,
        subject: "t",
        openedAt: new Date("2026-10-20"),
      },
    });
    await syncInbox(w.actor, { now: NOW });
    await w.db.ticket.update({
      where: { id: t.id },
      data: { status: "CLOSED", closedAt: new Date("2026-10-31") },
    });
    await syncInbox(w.actor, { now: NOW });
    expect((await w.db.inboxItem.findFirstOrThrow({ where: { sourceId: t.id } })).status).toBe(
      "CLOSED",
    );
    await w.db.inboxItem.updateMany({
      where: { sourceId: inbound.id },
      data: { status: "CLOSED" },
    });
    await syncInbox(w.actor, { now: NOW });
    expect(
      (await w.db.inboxItem.findFirstOrThrow({ where: { sourceId: inbound.id } })).status,
    ).toBe("CLOSED");
  });

  it("an old closed ticket and an old email are left out; an old but still-open ticket is in", async () => {
    const w = await world("InboxLookback");
    const tconv = (at: string) =>
      w.db.conversation.create({
        data: {
          workspaceId: w.ws,
          accountId: w.halden.id,
          channel: "TICKET",
          subject: "t",
          startedAt: new Date(at),
          lastMessageAt: new Date(at),
        },
      });
    const c1 = await tconv("2026-08-01");
    const c2 = await tconv("2026-08-01");
    await w.db.ticket.create({
      data: {
        workspaceId: w.ws,
        accountId: w.halden.id,
        conversationId: c1.id,
        subject: "old closed",
        status: "CLOSED",
        openedAt: new Date("2026-08-01"),
        closedAt: new Date("2026-08-05"),
      },
    });
    const open = await w.db.ticket.create({
      data: {
        workspaceId: w.ws,
        accountId: w.halden.id,
        conversationId: c2.id,
        subject: "old open",
        openedAt: new Date("2026-08-01"),
      },
    });
    const ec = await w.db.conversation.create({
      data: {
        workspaceId: w.ws,
        accountId: w.halden.id,
        channel: "EMAIL",
        subject: "e",
        startedAt: new Date("2026-08-01"),
        lastMessageAt: new Date("2026-08-01"),
      },
    });
    await w.db.message.create({
      data: {
        workspaceId: w.ws,
        accountId: w.halden.id,
        conversationId: ec.id,
        direction: "INBOUND",
        sentAt: new Date("2026-08-01T10:00:00Z"),
        subject: "e",
        bodyText: "old",
      },
    });
    await syncInbox(w.actor, { now: NOW });
    expect((await w.db.inboxItem.findMany()).map((i) => i.sourceId)).toEqual([open.id]);
  });

  it("reads a fixed number of times however many records there are (no N+1)", async () => {
    const w = await world("InboxBudget");
    const seed = async (n: number, label: string) => {
      for (let i = 0; i < n; i++) {
        const c = await w.db.conversation.create({
          data: {
            workspaceId: w.ws,
            accountId: w.halden.id,
            channel: "EMAIL",
            subject: `${label}${i}`,
            startedAt: new Date("2026-10-30"),
            lastMessageAt: new Date("2026-10-30"),
          },
        });
        await w.db.message.create({
          data: {
            workspaceId: w.ws,
            accountId: w.halden.id,
            conversationId: c.id,
            direction: "INBOUND",
            sentAt: new Date("2026-10-30T10:00:00Z"),
            subject: "s",
            bodyText: "q",
          },
        });
      }
    };
    await seed(2, "a");
    await syncInbox(w.actor, { now: NOW });
    const two = await countQueries(() => syncInbox(w.actor, { now: NOW }));
    await seed(10, "b");
    await syncInbox(w.actor, { now: NOW });
    const twelve = await countQueries(() => syncInbox(w.actor, { now: NOW }));
    expect(twelve.queries).toBe(two.queries);
  });
});
