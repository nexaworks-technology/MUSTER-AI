import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";

/**
 * D-56: Contact.statusChangedAt and Ticket.escalatedAt record WHEN a fact became true, so a
 * back-test never sees it early. The database fills them on a real change for every writer;
 * an explicit date wins; an unchanged re-write leaves them alone (import idempotency).
 */
let db: ReturnType<typeof scopedDb>;
let ws: string;
let accountId: string;

beforeAll(async () => {
  const { actor } = await createTestAdmin("PointInTime");
  ws = actor.workspaceId;
  db = scopedDb(actor);
  accountId = (
    await db.account.create({ data: { workspaceId: ws, name: "PIT", tier: "MID_TOUCH" } })
  ).id;
});

describe("point-in-time fields (D-56)", () => {
  it("stamps a contact's status change, and only a real change", async () => {
    const c = await db.contact.create({ data: { workspaceId: ws, accountId, name: "Ana" } });
    expect(c.statusChangedAt).toBeNull();
    const bounced = await db.contact.update({ where: { id: c.id }, data: { status: "BOUNCED" } });
    expect(bounced.statusChangedAt).toBeInstanceOf(Date);
    const again = await db.contact.update({
      where: { id: c.id },
      data: { title: "Ops", status: "BOUNCED" },
    });
    expect(again.statusChangedAt).toEqual(bounced.statusChangedAt);
  });

  it("keeps an explicit status date (seed and CSV history)", async () => {
    const when = new Date("2026-09-01T10:00:00Z");
    const c = await db.contact.create({
      data: { workspaceId: ws, accountId, name: "Ben", status: "LEFT", statusChangedAt: when },
    });
    expect(c.statusChangedAt).toEqual(when);
    const created = await db.contact.create({
      data: { workspaceId: ws, accountId, name: "Cy", status: "LEFT" },
    });
    expect(created.statusChangedAt).toBeInstanceOf(Date);
  });

  it("stamps a ticket's escalation, keeps an explicit date, ignores unchanged writes", async () => {
    const openedAt = new Date("2026-10-01T09:00:00Z");
    const t = await db.ticket.create({
      data: { workspaceId: ws, accountId, subject: "x", openedAt },
    });
    expect(t.escalatedAt).toBeNull();
    const esc = await db.ticket.update({ where: { id: t.id }, data: { isEscalated: true } });
    expect(esc.escalatedAt).toBeInstanceOf(Date);
    const same = await db.ticket.update({
      where: { id: t.id },
      data: { isEscalated: true, subject: "y" },
    });
    expect(same.escalatedAt).toEqual(esc.escalatedAt);
    const when = new Date("2026-10-02T12:00:00Z");
    const explicit = await db.ticket.create({
      data: {
        workspaceId: ws,
        accountId,
        subject: "z",
        openedAt,
        isEscalated: true,
        escalatedAt: when,
      },
    });
    expect(explicit.escalatedAt).toEqual(when);
  });
});
