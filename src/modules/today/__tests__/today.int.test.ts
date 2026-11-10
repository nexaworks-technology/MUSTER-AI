import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { getToday, rebuildToday } from "../service";

/**
 * Today on real records (M4 §2, acceptance #9): own book only, ranked with reasons, ARR hidden
 * without revenue access but the same order, an honest empty Meetings section, 25 per page.
 */
const clock = () => new Date("2026-11-03T15:00:00Z"); // Nov 3 in UTC (the test workspace's zone)

let db: ScopedDb;
let ws: string;
let leo: Actor;
let leoNoRev: Actor;
let big: string;
let small: string;

async function member(name: string, canViewRevenue: boolean): Promise<Actor> {
  const user = await rawDb.user.create({ data: { email: `${name}-${randomUUID()}@t.test`, name } });
  const m = await db.membership.create({
    data: { workspaceId: ws, userId: user.id, role: "CSM", canViewRevenue },
  });
  return {
    workspaceId: ws,
    userId: user.id,
    membershipId: m.id,
    role: "CSM",
    canViewRevenue,
    bookScope: "OWN",
  };
}

beforeAll(async () => {
  const { actor } = await createTestAdmin("Today");
  ws = actor.workspaceId;
  db = scopedDb(actor);
  leo = await member("Leo", true);
  leoNoRev = await member("LeoNoRev", false);
  const acct = (name: string, arr: bigint, owner: string, renewal?: string) =>
    db.account.create({
      data: {
        workspaceId: ws,
        name,
        tier: "HIGH_TOUCH",
        arrMinor: arr,
        arrCurrency: "USD",
        ownerMembershipId: owner,
        ...(renewal ? { renewalDate: new Date(`${renewal}T00:00:00Z`) } : {}),
      },
    });
  big = (await acct("Brightwell", 142_000_00n, leo.membershipId, "2026-11-25")).id;
  // FIX-2026-11-11: Today's renewals are read from Renewal records (the Renewals page's source),
  // so Brightwell's 2026-11-25 renewal exists as one. Arrangement only; assertions unchanged.
  const contract = await db.contract.create({
    data: {
      workspaceId: ws,
      accountId: big,
      startDate: new Date("2025-11-25T00:00:00Z"),
      endDate: new Date("2026-11-25T00:00:00Z"),
      valueMinor: 142_000_00n,
    },
  });
  await db.renewal.create({
    data: {
      workspaceId: ws,
      accountId: big,
      contractId: contract.id,
      renewalDate: new Date("2026-11-25T00:00:00Z"),
      arrAtRiskMinor: 142_000_00n,
      currency: "USD",
      confidence: 60,
      confidenceBand: "MEDIUM",
      confidenceAsOf: new Date("2026-11-03T00:00:00Z"),
    },
  });
  small = (await acct("Tinyco", 2_000_00n, leo.membershipId)).id;
  const otherOwner = (await acct("Not Leo's", 999_000_00n, actor.membershipId)).id;
  const task = (accountId: string, title: string, dueAt: string, owner = leo.membershipId) =>
    db.task.create({
      data: { workspaceId: ws, accountId, title, ownerMembershipId: owner, dueAt: new Date(dueAt) },
    });
  await task(big, "Call about seats", "2026-11-01T17:00:00Z"); // 2 days overdue
  await task(small, "Send the guide", "2026-11-03T17:00:00Z"); // due today
  await task(small, "Next week", "2026-11-10T17:00:00Z"); // not today
  await task(otherOwner, "Someone else's", "2026-11-01T17:00:00Z", actor.membershipId);
  await db.signal.create({
    data: {
      workspaceId: ws,
      accountId: big,
      ruleKey: "usage_drop_vs_normal",
      ruleVersion: 1,
      category: "USAGE",
      severity: "CRITICAL",
      polarity: "RISK",
      title: "Usage drop vs normal",
      explanation: "e",
      evidence: [{ sourceType: "Account", sourceId: big }],
      values: {},
      params: {},
      dedupeKey: `d:${big}`,
      firstSeenAt: new Date("2026-11-01"),
      lastSeenAt: new Date("2026-11-02"),
    },
  });
  for (const m of [leo, leoNoRev])
    for (let i = 0; i < 27; i++)
      await db.approval.create({
        data: {
          workspaceId: ws,
          accountId: small,
          kind: "CREATE_TASK",
          reason: `Approval ${i}`,
          requiredLevel: "DRAFT_FOR_APPROVAL",
          assigneeId: m.membershipId,
        },
      });
});

describe("Today", () => {
  it("shows only the member's own work, ranked, with reasons", async () => {
    const sections = await getToday(leo, { clock });
    const tasks = sections.find((s) => s.key === "TASK")!;
    expect(tasks.items.map((i) => i.title)).toEqual(["Call about seats", "Send the guide"]);
    expect(tasks.items[0]!.reasons.map((r) => r.label)).toEqual(["$142k ARR", "overdue 2 days"]);
    const signals = sections.find((s) => s.key === "SIGNAL")!;
    expect(signals.items.map((i) => [i.title, i.reasons.map((r) => r.label).join(" × ")])).toEqual([
      ["Usage drop vs normal", "$142k ARR × Critical signal"],
    ]);
    const renewals = sections.find((s) => s.key === "RENEWAL")!;
    expect(renewals.items.map((i) => i.accountId)).toEqual([big]);
    expect(sections.find((s) => s.key === "MEETING")!.total).toBe(0);
    expect(JSON.stringify(sections)).not.toContain("Not Leo's");
  });

  it("paginates 25 per section", async () => {
    const approvals = (await getToday(leo, { clock })).find((s) => s.key === "APPROVAL")!;
    expect(approvals.total).toBe(27);
    expect(approvals.items).toHaveLength(25);
    expect(approvals.next).toBe(25);
    const page2 = (await getToday(leo, { clock, cursors: { APPROVAL: 25 } })).find(
      (s) => s.key === "APPROVAL",
    )!;
    expect(page2.items).toHaveLength(2);
  });

  it("without revenue access the ARR is hidden and the order is unchanged", async () => {
    // Give the no-revenue member the same accounts and work.
    await db.account.updateMany({
      where: { id: { in: [big, small] } },
      data: { ownerMembershipId: leoNoRev.membershipId },
    });
    await db.task.updateMany({
      where: { accountId: { in: [big, small] } },
      data: { ownerMembershipId: leoNoRev.membershipId },
    });
    await rebuildToday(leoNoRev, clock);
    const tasks = (await getToday(leoNoRev, { clock })).find((s) => s.key === "TASK")!;
    expect(tasks.items.map((i) => i.title)).toEqual(["Call about seats", "Send the guide"]);
    expect(JSON.stringify(tasks.items.map((i) => i.reasons))).not.toMatch(/\$|ARR/);
    await db.account.updateMany({
      where: { id: { in: [big, small] } },
      data: { ownerMembershipId: leo.membershipId },
    });
    await db.task.updateMany({
      where: { accountId: { in: [big, small] } },
      data: { ownerMembershipId: leo.membershipId },
    });
  });
});
