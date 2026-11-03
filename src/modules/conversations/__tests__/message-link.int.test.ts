import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { CONVERSATION_PAGE, conversationPageFor, listConversations } from "../service";

/**
 * A health reason cites one message (M3 rule 2). Its link must land on the page of the
 * Conversations tab that holds it, however old it is, or the proof is a dead anchor.
 */
let actor: Actor;
let accountId: string;
const oldMessages: string[] = [];
let newest: string;
const at = (d: number) => new Date(Date.UTC(2026, 9, 1) + d * 3_600_000);

beforeAll(async () => {
  actor = (await createTestAdmin("MessageLink")).actor;
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  accountId = (
    await db.account.create({ data: { workspaceId: ws, name: "Chatty", tier: "MID_TOUCH" } })
  ).id;
  // 2½ pages of threads, newest first on the tab.
  for (let i = 0; i < CONVERSATION_PAGE * 2 + 5; i++) {
    const c = await db.conversation.create({
      data: {
        workspaceId: ws,
        accountId,
        channel: "EMAIL",
        subject: `Thread ${i}`,
        startedAt: at(i),
        lastMessageAt: at(i),
      },
    });
    const m = await db.message.create({
      data: {
        workspaceId: ws,
        conversationId: c.id,
        accountId,
        direction: "INBOUND",
        sentAt: at(i),
        bodyText: `Message ${i}`,
      },
    });
    if (i < 3) oldMessages.push(m.id);
    newest = m.id;
  }
});

describe("linking to one message", () => {
  it("finds the page and the thread for an old message, and that page holds it", async () => {
    const target = await conversationPageFor(actor, accountId, oldMessages[0]!);
    expect(target).not.toBeNull();
    expect(target!.offset).toBe(CONVERSATION_PAGE * 2);
    const page = await listConversations(actor, accountId, target!.offset);
    const thread = page.conversations.find((c) => c.id === target!.conversationId);
    expect(thread?.messages.map((m) => m.id)).toContain(oldMessages[0]);
  });

  it("the newest message is on the first page", async () => {
    expect((await conversationPageFor(actor, accountId, newest))?.offset).toBe(0);
  });

  it("returns null for an unknown message or one from another workspace", async () => {
    expect(await conversationPageFor(actor, accountId, "nope")).toBeNull();
    const other = (await createTestAdmin("MessageLinkOther")).actor;
    expect(await conversationPageFor(other, accountId, oldMessages[0]!)).toBeNull();
  });
});
