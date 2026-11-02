import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createNote, listNotes } from "@/modules/notes/service";
import { listMyNotifications, markAllRead, unreadCount } from "@/modules/notifications/service";
import { createTestAdmin } from "@/test/fixtures";
import { completeTask, createTask, listMyTasks } from "../service";

let admin: Actor;
let aisha: Actor;
let leo: Actor;
let aishaAccount: string;

async function member(base: Actor, name: string): Promise<Actor> {
  const db = scopedDb(base);
  const user = await db.user.create({
    data: { email: `${name.split(" ")[0]!.toLowerCase()}-${base.workspaceId}@example.test`, name },
  });
  const m = await db.membership.create({
    data: { workspaceId: base.workspaceId, userId: user.id, role: "CSM" },
  });
  return {
    ...base,
    userId: user.id,
    membershipId: m.id,
    role: "CSM",
    canViewRevenue: false,
    bookScope: "OWN",
  };
}

beforeAll(async () => {
  admin = (await createTestAdmin("Work")).actor;
  aisha = await member(admin, "Aisha Bello");
  leo = await member(admin, "Leo Marsh");
  aishaAccount = (
    await scopedDb(admin).account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Pinecrest Test",
        tier: "MID_TOUCH",
        ownerMembershipId: aisha.membershipId,
      },
    })
  ).id;
});

describe("tasks", () => {
  it("assigning a task to someone else notifies them; it appears in their list, soonest due first", async () => {
    const later = await createTask(admin, {
      accountId: aishaAccount,
      title: "Later",
      ownerMembershipId: aisha.membershipId,
      dueAt: "2026-12-01",
    });
    const soon = await createTask(admin, {
      accountId: aishaAccount,
      title: "Soon",
      ownerMembershipId: aisha.membershipId,
      dueAt: "2026-11-03",
    });
    expect((await listMyTasks(aisha)).map((t) => t.id).slice(0, 2)).toEqual([soon.id, later.id]);
    expect(
      (await listMyNotifications(aisha)).some(
        (n) => n.type === "TASK_ASSIGNED" && n.refId === soon.id,
      ),
    ).toBe(true);
  });

  it("a CSM cannot create tasks on an account outside their book", async () => {
    await expect(
      createTask(leo, { accountId: aishaAccount, title: "x", ownerMembershipId: leo.membershipId }),
    ).rejects.toThrow(/not found/i);
  });

  it("a Viewer cannot create tasks", async () => {
    await expect(
      createTask(
        { ...admin, role: "VIEWER" },
        { title: "x", ownerMembershipId: admin.membershipId },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the owner can complete their task; an unrelated CSM cannot", async () => {
    const task = await createTask(admin, {
      accountId: aishaAccount,
      title: "Complete me",
      ownerMembershipId: aisha.membershipId,
    });
    await expect(completeTask(leo, task.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await completeTask(aisha, task.id)).status).toBe("DONE");
  });

  it("rejects an invalid due date in plain words", async () => {
    await expect(
      createTask(admin, { title: "x", ownerMembershipId: admin.membershipId, dueAt: "31/13/2026" }),
    ).rejects.toThrow(/valid due date/);
  });
});

describe("notes and mentions", () => {
  it("a mention notifies members who can see the account and reports the ones who cannot", async () => {
    const { notified, notNotified } = await createNote(admin, {
      accountId: aishaAccount,
      body: "Kickoff went well. @Aisha Bello please follow up on SSO; @Leo Marsh FYI.",
      tags: "onboarding, sso",
    });
    expect(notified).toBe(1);
    expect(notNotified).toEqual(["Leo Marsh"]);
    const bell = await listMyNotifications(aisha);
    expect(bell[0]).toMatchObject({
      type: "MENTION",
      title: expect.stringContaining("Pinecrest Test"),
    });
    expect((await listMyNotifications(leo)).some((n) => n.type === "MENTION")).toBe(false);
    const [note] = await listNotes(admin, aishaAccount);
    expect(note!.tags).toEqual(["onboarding", "sso"]);
  });

  it("marking all read clears the unread count", async () => {
    expect(await unreadCount(aisha)).toBeGreaterThan(0);
    await markAllRead(aisha);
    expect(await unreadCount(aisha)).toBe(0);
  });
});
