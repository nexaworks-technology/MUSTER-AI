import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { recomputeLastTouch, type Actor } from "@/modules/accounts/service";
import { listTickets } from "@/modules/support/service";
import { createTestAdmin } from "@/test/fixtures";
import { countQueries } from "@/test/query-counter";
import { listConversations } from "../service";

let actor: Actor;
let accountId: string;
let foreignAccount: string;
const at = (d: number) => new Date(Date.UTC(2026, 9, d, 15));

beforeAll(async () => {
  actor = (await createTestAdmin("Conv")).actor;
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  accountId = (
    await db.account.create({ data: { workspaceId: ws, name: "Talky", tier: "MID_TOUCH" } })
  ).id;
  const email = await db.conversation.create({
    data: {
      workspaceId: ws,
      accountId,
      channel: "EMAIL",
      subject: "Hello",
      startedAt: at(10),
      lastMessageAt: at(12),
    },
  });
  await db.message.createMany({
    data: [
      {
        workspaceId: ws,
        conversationId: email.id,
        accountId,
        direction: "OUTBOUND",
        sentAt: at(10),
        bodyText: "Hi",
      },
      {
        workspaceId: ws,
        conversationId: email.id,
        accountId,
        direction: "INBOUND",
        sentAt: at(12),
        bodyText: "Hi back",
      },
    ],
  });
  const tconv = await db.conversation.create({
    data: {
      workspaceId: ws,
      accountId,
      channel: "TICKET",
      subject: "Broken",
      startedAt: at(20),
      lastMessageAt: at(20),
    },
  });
  await db.message.create({
    data: {
      workspaceId: ws,
      conversationId: tconv.id,
      accountId,
      direction: "INBOUND",
      sentAt: at(20),
      bodyText: "It broke",
    },
  });
  await db.ticket.createMany({
    data: [
      {
        workspaceId: ws,
        accountId,
        conversationId: tconv.id,
        subject: "Broken",
        openedAt: at(20),
        status: "OPEN",
        priority: "HIGH",
      },
      {
        workspaceId: ws,
        accountId,
        subject: "Old one",
        openedAt: at(25),
        status: "CLOSED",
        closedAt: at(26),
      },
    ],
  });
  const call = await db.conversation.create({
    data: {
      workspaceId: ws,
      accountId,
      channel: "CALL",
      subject: "Call",
      startedAt: at(5),
      lastMessageAt: at(5),
    },
  });
  await db.callTranscript.create({
    data: {
      workspaceId: ws,
      accountId,
      conversationId: call.id,
      title: "Call",
      provider: "upload",
      occurredAt: at(5),
      text: "A: hello",
    },
  });
  const other = await createTestAdmin("ConvOther");
  foreignAccount = (
    await scopedDb(other.actor).account.create({
      data: { workspaceId: other.actor.workspaceId, name: "Elsewhere", tier: "LONG_TAIL" },
    })
  ).id;
});

describe("support and conversations read models", () => {
  it("lists email and call conversations (not ticket threads), newest first, with transcripts", async () => {
    const { conversations } = await listConversations(actor, accountId);
    expect(conversations.map((c) => c.channel)).toEqual(["EMAIL", "CALL"]);
    expect(conversations[1]!.transcripts[0]!.text).toBe("A: hello");
  });

  it("lists open tickets first with their thread and age", async () => {
    const tickets = await listTickets(actor, accountId, at(29));
    expect(tickets.map((t) => t.subject)).toEqual(["Broken", "Old one"]);
    expect(tickets[0]).toMatchObject({ isOpen: true, ageDays: 9 });
    expect(tickets[0]!.messages.map((m) => m.bodyText)).toEqual(["It broke"]);
  });

  it("derives last touch from emails and calls, never from support tickets", async () => {
    await recomputeLastTouch(scopedDb(actor), actor.workspaceId);
    const account = await scopedDb(actor).account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.lastTouchAt?.toISOString()).toBe(at(12).toISOString());
  });

  it("loads with a fixed number of queries", async () => {
    const { queries } = await countQueries(() => listConversations(actor, accountId));
    expect(queries).toBeLessThanOrEqual(8);
  });

  it("another workspace's account is not found", async () => {
    await expect(listConversations(actor, foreignAccount)).rejects.toThrow(/not found/);
    await expect(listTickets(actor, foreignAccount)).rejects.toThrow(/not found/);
  });
});
