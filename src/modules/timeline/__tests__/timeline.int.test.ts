import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { countQueries } from "@/test/query-counter";
import { getTimeline } from "../service";

let admin: Actor;
let accountId: string;
let foreign: string;
const day = (n: number) => new Date(Date.now() - n * 86_400_000);

beforeAll(async () => {
  admin = (await createTestAdmin("Timeline")).actor;
  const db = scopedDb(admin);
  const ws = admin.workspaceId;
  accountId = (
    await db.account.create({ data: { workspaceId: ws, name: "History Co", tier: "MID_TOUCH" } })
  ).id;
  const contact = await db.contact.create({ data: { workspaceId: ws, accountId, name: "Pat" } });
  await db.stakeholderRole.create({
    data: {
      workspaceId: ws,
      accountId,
      contactId: contact.id,
      role: "CHAMPION",
      validFrom: day(90),
      validTo: day(5),
    },
  });
  const email = await db.conversation.create({
    data: {
      workspaceId: ws,
      accountId,
      channel: "EMAIL",
      subject: "Hello",
      startedAt: day(3),
      lastMessageAt: day(3),
    },
  });
  await db.message.create({
    data: {
      workspaceId: ws,
      accountId,
      conversationId: email.id,
      direction: "INBOUND",
      fromContactId: contact.id,
      sentAt: day(3),
      subject: "Hello",
      bodyText: "Hi",
    },
  });
  const call = await db.conversation.create({
    data: { workspaceId: ws, accountId, channel: "CALL", startedAt: day(8), lastMessageAt: day(8) },
  });
  await db.callTranscript.create({
    data: {
      workspaceId: ws,
      accountId,
      conversationId: call.id,
      title: "Monthly call",
      provider: "upload",
      occurredAt: day(8),
      text: "x",
    },
  });
  await db.ticket.create({
    data: {
      workspaceId: ws,
      accountId,
      subject: "Broken export",
      openedAt: day(12),
      closedAt: day(10),
      status: "CLOSED",
      priority: "HIGH",
    },
  });
  const contract = await db.contract.create({
    data: { workspaceId: ws, accountId, startDate: day(200), valueMinor: 1_200_000n },
  });
  await db.invoice.create({
    data: {
      workspaceId: ws,
      accountId,
      number: "INV-9",
      amountMinor: 1_200_000n,
      issuedAt: day(40),
      dueAt: day(10),
      lastFailedAt: day(9),
      failureCount: 1,
      status: "FAILED",
    },
  });
  await db.revenueEvent.create({
    data: {
      workspaceId: ws,
      accountId,
      type: "NEW",
      deltaArrMinor: 1_200_000n,
      currency: "USD",
      effectiveDate: day(200),
      sourceType: "Contract",
      sourceId: contract.id,
    },
  });
  await db.note.create({
    data: {
      workspaceId: ws,
      accountId,
      authorMembershipId: admin.membershipId,
      body: "Met the team",
      createdAt: day(2),
    },
  });
  await db.task.create({
    data: {
      workspaceId: ws,
      accountId,
      title: "Follow up",
      ownerMembershipId: admin.membershipId,
      createdAt: day(1),
    },
  });
  // 12 weeks of usage with a clear drop in the last 3 weeks.
  for (let d = 84; d >= 0; d--) {
    await db.usageDaily.create({
      data: {
        workspaceId: ws,
        accountId,
        date: new Date(day(d).toISOString().slice(0, 10)),
        activeUsers: d < 21 ? 4 : 20,
        sessions: 1,
        events: 1,
      },
    });
  }
  const other = await createTestAdmin("TimelineOther");
  foreign = (
    await scopedDb(other.actor).account.create({
      data: { workspaceId: other.actor.workspaceId, name: "X", tier: "LONG_TAIL" },
    })
  ).id;
});

async function everything(actor: Actor) {
  const items = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const page: Awaited<ReturnType<typeof getTimeline>> = await getTimeline(
      actor,
      accountId,
      cursor,
    );
    items.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return items;
}

describe("account timeline", () => {
  it("includes every M2 source type, newest first", async () => {
    const items = await everything(admin);
    expect(new Set(items.map((i) => i.kind))).toEqual(
      new Set([
        "email",
        "call",
        "ticket",
        "invoice",
        "usage",
        "note",
        "task",
        "people",
        "contract",
        "revenue",
      ]),
    );
    for (let i = 1; i < items.length; i++)
      expect(items[i - 1]!.at.getTime()).toBeGreaterThanOrEqual(items[i]!.at.getTime());
    expect(items.some((i) => i.title.startsWith("Usage fell"))).toBe(true);
    expect(items.some((i) => i.title === "Pat is no longer champion")).toBe(true);
    expect(items.some((i) => i.title.startsWith("Payment failed for invoice INV-9"))).toBe(true);
  });

  it("pages through without repeats", async () => {
    const items = await everything(admin);
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });

  it("shows no money without revenue access", async () => {
    const items = await everything({ ...admin, canViewRevenue: false });
    expect(items.some((i) => /\$/.test(i.title))).toBe(false);
    const withMoney = await everything(admin);
    expect(withMoney.some((i) => /\$12,000/.test(i.title))).toBe(true);
  });

  // 7 sources + the account header; Prisma resolves each relation include as one batched
  // query (messages → contacts / members → users; notes → authors → users), never per row.
  it("loads a page with a fixed number of queries", async () => {
    const { queries } = await countQueries(() => getTimeline(admin, accountId));
    expect(queries).toBeLessThanOrEqual(16);
  });

  it("another workspace's account is not found", async () => {
    await expect(getTimeline(admin, foreign)).rejects.toThrow(/not found/);
  });
});
