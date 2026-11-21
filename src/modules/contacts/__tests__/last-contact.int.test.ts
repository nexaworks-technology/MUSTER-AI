import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { listPeople } from "../service";

/**
 * DEMO-WALKTHROUGH FAIL 11: every connector-ingested contact read "Last contact: none recorded"
 * while Champion Guard on the same page said the person wrote to us. Last contact now comes from
 * the same records Champion Guard reads: the latest message the person sent us, from any source.
 */
const at = (iso: string) => new Date(`${iso}T10:00:00Z`);

describe("People › last contact", () => {
  it("is the latest message the person wrote to us, with its channel; none when they never wrote", async () => {
    const { actor } = await createTestAdmin("LastContact");
    const db = scopedDb(actor);
    const ws = actor.workspaceId;
    const account = await db.account.create({
      data: { workspaceId: ws, name: "Halvorsen-like", tier: "HIGH_TOUCH" },
    });
    const delia = await db.contact.create({
      data: { workspaceId: ws, accountId: account.id, name: "Delia", email: "delia@h.test" },
    });
    const quiet = await db.contact.create({
      data: { workspaceId: ws, accountId: account.id, name: "Quiet", email: "q@h.test" },
    });
    const conv = (channel: "EMAIL" | "TICKET") =>
      db.conversation.create({
        data: {
          workspaceId: ws,
          accountId: account.id,
          channel,
          startedAt: at("2026-11-01"),
          lastMessageAt: at("2026-11-19"),
        },
      });
    const email = await conv("EMAIL");
    const ticket = await conv("TICKET");
    const msg = (
      conversationId: string,
      direction: "INBOUND" | "OUTBOUND",
      day: string,
      from: string | null,
    ) =>
      db.message.create({
        data: {
          workspaceId: ws,
          accountId: account.id,
          conversationId,
          direction,
          fromContactId: from,
          sentAt: at(day),
          bodyText: "hi",
          source: "GMAIL",
        },
      });
    await msg(ticket.id, "INBOUND", "2026-11-03", delia.id);
    const latest = await msg(email.id, "INBOUND", "2026-11-17", delia.id);
    await msg(email.id, "OUTBOUND", "2026-11-19", null); // ours, not theirs

    const people = await listPeople(actor, account.id);
    const d = people.find((p) => p.id === delia.id)!;
    expect(d.lastContact).toEqual({ at: at("2026-11-17"), channel: "EMAIL", messageId: latest.id });
    expect(people.find((p) => p.id === quiet.id)!.lastContact).toBeNull();
  });

  it("a date kept on the contact (e.g. set by hand or a CRM) is used when it is later", async () => {
    const { actor } = await createTestAdmin("LastContactKept");
    const db = scopedDb(actor);
    const account = await db.account.create({
      data: { workspaceId: actor.workspaceId, name: "Kept", tier: "MID_TOUCH" },
    });
    await db.contact.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: account.id,
        name: "Kept",
        lastContactAt: at("2026-11-10"),
      },
    });
    const [p] = await listPeople(actor, account.id);
    expect(p!.lastContact).toEqual({ at: at("2026-11-10"), channel: null, messageId: null });
  });
});
