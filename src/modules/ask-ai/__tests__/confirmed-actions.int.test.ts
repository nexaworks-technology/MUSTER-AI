import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import { approve, reject } from "@/modules/approvals/service";
import { createTestAdmin } from "@/test/fixtures";
import { proposeChanges, type AskActor } from "../service";

/**
 * M11 S9 (test-first): Ask AI may PROPOSE record changes but never applies one (M11 rule 1,
 * D-160). A proposal is a real Approval carrying the exact change list; nothing happens until a
 * human approves it through approvals.approve() — the same call /approvals makes, with the same
 * authority. On approval every item runs through its own module service as the decider (per-item
 * permission checks); items that cannot run are skipped with a reason; one audit row per item.
 */
const NOW = new Date("2026-11-02T12:00:00Z");
const clock = () => NOW;
let admin: AskActor;
let leo: AskActor;
let db: ScopedDb;
let ws: string;
let playId: string;

async function csm(name: string): Promise<AskActor> {
  const user = await rawDb.user.create({
    data: { email: `${name}-${randomUUID().slice(0, 8)}@example.test`, name },
  });
  const m = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, true)`;
    return tx.membership.create({
      data: {
        workspaceId: ws,
        userId: user.id,
        role: "CSM",
        bookScope: "OWN",
        canViewRevenue: false,
      },
    });
  });
  return {
    workspaceId: ws,
    userId: user.id,
    membershipId: m.id,
    role: m.role,
    canViewRevenue: false,
    bookScope: m.bookScope,
  };
}

const account = (owner: string | null, name: string, stage: "MATURE" | "LOST" = "MATURE") =>
  db.account.create({
    data: {
      workspaceId: ws,
      name,
      tier: "MID_TOUCH",
      ownerMembershipId: owner,
      lifecycleStage: stage,
    },
  });

beforeAll(async () => {
  ({ actor: admin } = await createTestAdmin("AskAct"));
  ws = admin.workspaceId;
  db = scopedDb(admin);
  leo = await csm("leo");
  const play = await db.play.create({
    data: {
      workspaceId: ws,
      key: `renewal-risk-${randomUUID().slice(0, 6)}`,
      name: "Renewal Risk",
      status: "PUBLISHED",
    },
  });
  const version = await db.playVersion.create({
    data: {
      workspaceId: ws,
      playId: play.id,
      version: 1,
      definition: { steps: [] },
      publishedAt: NOW,
    },
  });
  await db.play.update({ where: { id: play.id }, data: { currentVersionId: version.id } });
  playId = play.id;
});

const snapshot = async (accountIds: string[]) => ({
  tasks: await db.task.count({ where: { accountId: { in: accountIds } } }),
  runs: await db.playRun.count({ where: { accountId: { in: accountIds } } }),
  tiers: (
    await db.account.findMany({
      where: { id: { in: accountIds } },
      select: { tier: true },
      orderBy: { id: "asc" },
    })
  ).map((a) => a.tier),
});

describe("confirmed actions", () => {
  it("a proposal creates one pending Approval with the exact change list and changes nothing", async () => {
    const a1 = await account(leo.membershipId, "Prop A1");
    const a2 = await account(leo.membershipId, "Prop A2");
    const before = await snapshot([a1.id, a2.id]);
    const p = await proposeChanges(leo, {
      reason: "Move my renewal-risk accounts into the Renewal Risk play",
      items: [
        { kind: "ENROLL_PLAY", accountId: a1.id, playId },
        { kind: "ENROLL_PLAY", accountId: a2.id, playId },
        { kind: "UPDATE_FIELD", accountId: a1.id, field: "tier", value: "HIGH_TOUCH" },
        { kind: "CREATE_TASK", accountId: a2.id, title: "Call the champion" },
      ],
      proof: [{ sourceType: "Account", sourceId: a1.id }],
      sourceKey: `t:${randomUUID()}`,
    });
    expect(p.skipped).toEqual([]);
    const approval = await db.approval.findUniqueOrThrow({ where: { id: p.approvalId! } });
    expect(approval.status).toBe("PENDING");
    expect(approval.kind).toBe("BULK_ACTION");
    const payload = approval.payload as {
      changes: { items: Array<{ kind: string; label: string }> };
    };
    expect(payload.changes.items).toHaveLength(4);
    expect(payload.changes.items.every((i) => i.label.length > 0)).toBe(true);
    expect(await snapshot([a1.id, a2.id])).toEqual(before);
  });

  it("items the asker cannot act on are listed as skipped with a reason, never proposed", async () => {
    const aisha = await csm("aisha");
    const mine = await account(leo.membershipId, "Skip mine");
    const theirs = await account(aisha.membershipId, "Skip theirs");
    const p = await proposeChanges(leo, {
      reason: "Enrol both",
      items: [
        { kind: "ENROLL_PLAY", accountId: mine.id, playId },
        { kind: "ENROLL_PLAY", accountId: theirs.id, playId },
      ],
      proof: [{ sourceType: "Account", sourceId: mine.id }],
      sourceKey: `t:${randomUUID()}`,
    });
    expect(p.skipped).toEqual([{ index: 1, reason: expect.stringMatching(/cannot/i) }]);
    const approval = await db.approval.findUniqueOrThrow({ where: { id: p.approvalId! } });
    expect((approval.payload as { changes: { items: unknown[] } }).changes.items).toHaveLength(1);
    expect(JSON.stringify(approval.payload)).not.toContain(theirs.id);
  });

  it("nothing proposable → no Approval at all", async () => {
    const aisha = await csm("aisha2");
    const theirs = await account(aisha.membershipId, "Nothing");
    const p = await proposeChanges(leo, {
      reason: "x",
      items: [{ kind: "CREATE_TASK", accountId: theirs.id, title: "t" }],
      proof: [{ sourceType: "Account", sourceId: theirs.id }],
      sourceKey: `t:${randomUUID()}`,
    });
    expect(p.approvalId).toBeNull();
    expect(p.skipped).toHaveLength(1);
  });

  it("approve runs every item through its service as the decider; skipped items carry reasons; one audit row per item", async () => {
    const ok = await account(leo.membershipId, "Exec ok");
    const lost = await account(leo.membershipId, "Exec lost", "LOST");
    const p = await proposeChanges(leo, {
      reason: "Enrol and retier",
      items: [
        { kind: "ENROLL_PLAY", accountId: ok.id, playId },
        { kind: "ENROLL_PLAY", accountId: lost.id, playId },
        { kind: "UPDATE_FIELD", accountId: ok.id, field: "tier", value: "HIGH_TOUCH" },
        { kind: "CREATE_TASK", accountId: ok.id, title: "Book the QBR" },
      ],
      proof: [{ sourceType: "Account", sourceId: ok.id }],
      sourceKey: `t:${randomUUID()}`,
    });
    const res = await approve(leo, { approvalId: p.approvalId! }, { clock });
    expect(res.changes?.executed).toBe(3);
    expect(res.changes?.skipped).toEqual([
      expect.objectContaining({ index: 1, reason: expect.stringMatching(/lost|archived/i) }),
    ]);
    expect(await db.playRun.count({ where: { accountId: ok.id, playId } })).toBe(1);
    expect(await db.playRun.count({ where: { accountId: lost.id } })).toBe(0);
    expect((await db.account.findUniqueOrThrow({ where: { id: ok.id } })).tier).toBe("HIGH_TOUCH");
    expect(await db.task.count({ where: { accountId: ok.id, title: "Book the QBR" } })).toBe(1);
    const audits = await db.auditLog.findMany({
      where: {
        action: { in: ["approval.change_executed", "approval.change_skipped"] },
        targetId: p.approvalId!,
      },
    });
    expect(audits).toHaveLength(4);
    const stored = await db.approval.findUniqueOrThrow({ where: { id: p.approvalId! } });
    expect((stored.payload as { changeResults: unknown[] }).changeResults).toHaveLength(4);
  });

  it("a decider without authority over the account cannot approve it", async () => {
    const aisha = await csm("aisha3");
    const a = await account(leo.membershipId, "Authority");
    const p = await proposeChanges(leo, {
      reason: "Retier",
      items: [{ kind: "UPDATE_FIELD", accountId: a.id, field: "tier", value: "LONG_TAIL" }],
      proof: [{ sourceType: "Account", sourceId: a.id }],
      sourceKey: `t:${randomUUID()}`,
    });
    await expect(approve(aisha, { approvalId: p.approvalId! }, { clock })).rejects.toThrow();
    expect((await db.account.findUniqueOrThrow({ where: { id: a.id } })).tier).toBe("MID_TOUCH");
  });

  it("reject executes nothing", async () => {
    const a = await account(leo.membershipId, "Rejected");
    const before = await snapshot([a.id]);
    const p = await proposeChanges(leo, {
      reason: "Retier",
      items: [
        { kind: "UPDATE_FIELD", accountId: a.id, field: "tier", value: "LONG_TAIL" },
        { kind: "CREATE_TASK", accountId: a.id, title: "t" },
      ],
      proof: [{ sourceType: "Account", sourceId: a.id }],
      sourceKey: `t:${randomUUID()}`,
    });
    await reject(leo, { approvalId: p.approvalId!, note: "not now" }, { clock });
    expect(await snapshot([a.id])).toEqual(before);
  });

  it("an approval without a change list (plays, agents) executes nothing new on approve", async () => {
    const a = await account(admin.membershipId, "Legacy");
    const approval = await db.approval.create({
      data: {
        workspaceId: ws,
        accountId: a.id,
        kind: "CREATE_TASK",
        payload: {},
        reason: "legacy",
        proof: [{ sourceType: "Account", sourceId: a.id }],
        requiredLevel: "DRAFT_FOR_APPROVAL",
        sourceKey: `legacy:${randomUUID()}`,
      },
    });
    const res = await approve(admin, { approvalId: approval.id }, { clock });
    expect(res.changes).toBeUndefined();
    expect(await db.task.count({ where: { accountId: a.id } })).toBe(0);
  });
});
