import { describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin, createTestUser } from "@/test/fixtures";
import { listMeetingsIndex } from "../list";

/** A second member of the admin's workspace, shaped as the Actor services receive. */
async function addMember(
  workspaceId: string,
  label: string,
  role: "CSM" | "CS_LEADER",
  bookScope: "OWN" | "TEAM",
) {
  const user = await createTestUser(label);
  const membership = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx.membership.create({
      data: { workspaceId, userId: user.id, role, bookScope, canViewRevenue: false },
    });
  });
  return {
    workspaceId,
    userId: user.id,
    membershipId: membership.id,
    role,
    canViewRevenue: false,
    bookScope,
  };
}

const NOW = new Date("2026-11-10T12:00:00Z");
const at = (iso: string) => new Date(iso);

async function seed(label: string) {
  const admin = await createTestAdmin(label);
  const ws = admin.workspace.id;
  const csm = await addMember(ws, `${label}-csm`, "CSM", "OWN");
  const leader = await addMember(ws, `${label}-lead`, "CS_LEADER", "TEAM");
  const db = scopedDb({ workspaceId: ws });
  const mine = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Mine Co",
      tier: "HIGH_TOUCH",
      ownerMembershipId: csm.membershipId,
    },
  });
  const theirs = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Theirs Co",
      tier: "HIGH_TOUCH",
      ownerMembershipId: admin.membership.id,
    },
  });
  const meet = (title: string, accountId: string | null, startsAt: string) =>
    db.meeting.create({
      data: {
        workspaceId: ws,
        accountId,
        title,
        startsAt: at(startsAt),
        endsAt: new Date(at(startsAt).getTime() + 30 * 60_000),
      },
    });
  await meet("Mine past", mine.id, "2026-11-03T15:00:00Z");
  await meet("Mine soon", mine.id, "2026-11-11T15:00:00Z");
  await meet("Mine later", mine.id, "2026-11-20T15:00:00Z");
  await meet("Theirs soon", theirs.id, "2026-11-12T15:00:00Z");
  await meet("Unmatched call", null, "2026-11-13T15:00:00Z");
  const qbr = (accountId: string, title: string) =>
    db.document.create({
      data: {
        workspaceId: ws,
        accountId,
        kind: "QBR",
        title,
        metrics: { period: "Q3 2026" },
      },
    });
  await qbr(mine.id, "Mine QBR");
  await qbr(theirs.id, "Theirs QBR");
  // A brief is a Document too, and must never be listed as a QBR.
  await db.document.create({
    data: { workspaceId: ws, accountId: mine.id, kind: "PRE_CALL_BRIEF", title: "Mine brief" },
  });
  return { admin, csm, leader, mine, theirs };
}

describe("Meetings & QBRs index (spec §5)", () => {
  it("Admin sees every meeting and every QBR, including a call not matched to an account", async () => {
    const s = await seed("MtgAdm");
    const r = await listMeetingsIndex(s.admin.actor, { now: NOW });
    expect(r.upcoming.map((m) => m.title)).toEqual([
      "Mine soon",
      "Theirs soon",
      "Unmatched call",
      "Mine later",
    ]);
    expect(r.past.map((m) => m.title)).toEqual(["Mine past"]);
    expect(r.qbrs.map((q) => q.title).sort()).toEqual(["Mine QBR", "Theirs QBR"]);
    expect(r.upcoming.find((m) => m.title === "Unmatched call")?.accountName).toBeNull();
  });

  it("a CSM sees only their own book; unmatched calls and others' QBRs stay hidden", async () => {
    const s = await seed("MtgCsm");
    const r = await listMeetingsIndex(s.csm, { now: NOW });
    expect(r.upcoming.map((m) => m.title)).toEqual(["Mine soon", "Mine later"]);
    expect(r.past.map((m) => m.title)).toEqual(["Mine past"]);
    expect(r.qbrs.map((q) => q.title)).toEqual(["Mine QBR"]);
  });

  it("a CS Leader has the whole book (accounts:view is ALL for leaders), like Admin", async () => {
    const s = await seed("MtgLead");
    const r = await listMeetingsIndex(s.leader, { now: NOW });
    expect(r.upcoming.map((m) => m.title)).toEqual([
      "Mine soon",
      "Theirs soon",
      "Unmatched call",
      "Mine later",
    ]);
    expect(r.qbrs.map((q) => q.title).sort()).toEqual(["Mine QBR", "Theirs QBR"]);
  });

  it("filters to one account for the Account 360 tab", async () => {
    const s = await seed("MtgAcct");
    const r = await listMeetingsIndex(s.admin.actor, { now: NOW, accountId: s.mine.id });
    expect([...r.upcoming, ...r.past].every((m) => m.accountId === s.mine.id)).toBe(true);
    expect(r.qbrs.map((q) => q.title)).toEqual(["Mine QBR"]);
  });

  it("never leaks another workspace's meetings", async () => {
    const a = await seed("MtgIsoA");
    const b = await seed("MtgIsoB");
    const r = await listMeetingsIndex(a.admin.actor, { now: NOW });
    const other = await listMeetingsIndex(b.admin.actor, { now: NOW });
    const ids = new Set([...r.upcoming, ...r.past].map((m) => m.id));
    expect([...other.upcoming, ...other.past].some((m) => ids.has(m.id))).toBe(false);
  });
});
