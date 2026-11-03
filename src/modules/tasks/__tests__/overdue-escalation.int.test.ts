import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { getToday } from "@/modules/today/service";
import { createTestAdmin } from "@/test/fixtures";
import { escalateOverdueTasks } from "../service";

/**
 * Overdue escalation (spec §6F3, M4 acceptance #10): an overdue task reaches the CS Leader as a
 * notification and as an escalated item on their Today, once; the owner is told; it is audited.
 */
const clock = () => new Date("2026-11-03T15:00:00Z");
let db: ScopedDb;
let ws: string;
let aisha: Actor;
let dana: Actor;

async function member(name: string, role: "CSM" | "CS_LEADER"): Promise<Actor> {
  const user = await rawDb.user.create({ data: { email: `${name}-${randomUUID()}@t.test`, name } });
  const m = await db.membership.create({ data: { workspaceId: ws, userId: user.id, role } });
  return {
    workspaceId: ws,
    userId: user.id,
    membershipId: m.id,
    role,
    canViewRevenue: true,
    bookScope: role === "CS_LEADER" ? "ALL" : "OWN",
  };
}

beforeAll(async () => {
  const { actor } = await createTestAdmin("Escalation");
  ws = actor.workspaceId;
  db = scopedDb(actor);
  aisha = await member("Aisha Bello", "CSM");
  dana = await member("Dana Whitfield", "CS_LEADER");
});

describe("overdue escalation", () => {
  it("escalates an overdue task to the CS Leader's Today, once, and tells the owner", async () => {
    const account = await db.account.create({
      data: {
        workspaceId: ws,
        name: "Pinecrest Health",
        tier: "MID_TOUCH",
        arrMinor: 28_000_00n,
        arrCurrency: "USD",
        ownerMembershipId: aisha.membershipId,
      },
    });
    const task = (title: string, dueAt: string, status: "OPEN" | "DONE" = "OPEN") =>
      db.task.create({
        data: {
          workspaceId: ws,
          accountId: account.id,
          title,
          ownerMembershipId: aisha.membershipId,
          dueAt: new Date(dueAt),
          status,
        },
      });
    const overdue = await task("Chase SSO setup with Pinecrest IT", "2026-10-31T17:00:00Z");
    const dueToday = await task("Send the guide", "2026-11-03T17:00:00Z");
    const done = await task("Old done task", "2026-10-01T17:00:00Z", "DONE");

    expect(await escalateOverdueTasks({ workspaceId: ws }, clock)).toEqual({ escalated: 1 });
    expect(
      (await db.task.findUniqueOrThrow({ where: { id: overdue.id } })).escalatedAt,
    ).not.toBeNull();
    for (const t of [dueToday, done])
      expect((await db.task.findUniqueOrThrow({ where: { id: t.id } })).escalatedAt).toBeNull();

    const notes = await db.notification.findMany({
      where: { refId: overdue.id, type: "TASK_OVERDUE" },
    });
    expect(notes.map((n) => n.recipientMembershipId).sort()).toEqual(
      [aisha.membershipId, dana.membershipId].sort(),
    );
    expect(
      await db.auditLog.findFirst({ where: { targetId: overdue.id, action: "task.escalated" } }),
    ).not.toBeNull();
    expect(
      await rawDb.outboxEvent.count({ where: { workspaceId: ws, type: "task.overdue" } }),
    ).toBe(1);

    const today = await getToday(dana, { clock });
    const items = today.find((s) => s.key === "TASK")!.items;
    expect(items.map((i) => [i.title, i.reasons.map((r) => r.label).join(" × ")])).toEqual([
      [
        "Chase SSO setup with Pinecrest IT",
        "$28k ARR × escalated: Aisha Bello's task, overdue 3 days",
      ],
    ]);

    // A second run escalates nothing and notifies nobody again.
    expect(await escalateOverdueTasks({ workspaceId: ws }, clock)).toEqual({ escalated: 0 });
    expect(await db.notification.count({ where: { refId: overdue.id } })).toBe(2);
  });
});
