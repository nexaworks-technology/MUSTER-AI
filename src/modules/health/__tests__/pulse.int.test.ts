import { beforeAll, describe, expect, it } from "vitest";
import { addDays, utcMidnight } from "@/lib/dates";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { getAccountHealth, getActiveModel, scoreAndStore, setPulse } from "../service";

/**
 * CSM Pulse writes (spec §6C5, M3 rule 10): who and when are stored, it re-scores the account at
 * once, disagreement shows beside the score, and the score never silently changes to match.
 */
const TODAY = "2026-11-02";
const clock = () => new Date(`${TODAY}T15:00:00Z`);
let admin: Actor;
let owner: Actor;
let other: Actor;
let viewer: Actor;
let accountId: string;

async function member(ws: string, role: "CSM" | "VIEWER", label: string): Promise<Actor> {
  const db = scopedDb({ workspaceId: ws });
  const user = await db.user.create({
    data: { email: `${label}-${ws}@example.test`, name: label },
  });
  const m = await db.membership.create({ data: { workspaceId: ws, userId: user.id, role } });
  return {
    ...admin,
    userId: user.id,
    membershipId: m.id,
    role,
    canViewRevenue: false,
    bookScope: role === "VIEWER" ? "ALL" : "OWN",
  };
}

beforeAll(async () => {
  admin = (await createTestAdmin("PulseWrite")).actor;
  const ws = admin.workspaceId;
  owner = await member(ws, "CSM", "Owner");
  other = await member(ws, "CSM", "Other");
  viewer = await member(ws, "VIEWER", "Viewer");
  const db = scopedDb(admin);
  accountId = (
    await db.account.create({
      data: {
        workspaceId: ws,
        name: "Pulsed",
        tier: "MID_TOUCH",
        ownerMembershipId: owner.membershipId,
      },
    })
  ).id;
  const a = { workspaceId: ws, accountId };
  // A healthy account: steady usage and an active champion.
  await db.usageDaily.createMany({
    data: Array.from({ length: 120 }, (_, i) => ({
      ...a,
      date: utcMidnight(addDays(TODAY, -120 + i)),
      activeUsers: 30,
      sessions: 0,
      events: 0,
    })),
  });
  const c = await db.contact.create({ data: { ...a, name: "Champ" } });
  await db.stakeholderRole.create({
    data: { ...a, contactId: c.id, role: "CHAMPION", validFrom: new Date("2025-01-01") },
  });
  await scoreAndStore(admin, [accountId], TODAY, await getActiveModel(admin), {
    makeCurrent: true,
  });
});

describe("CSM Pulse writes", () => {
  it("only people who can edit the account may set a Pulse", async () => {
    // Outside their book the account does not exist for them (404), so they cannot pulse it.
    await expect(setPulse(other, accountId, { value: "WORRIED" }, clock)).rejects.toMatchObject({
      name: "AccountNotFoundError",
    });
    await expect(setPulse(viewer, accountId, { value: "WORRIED" }, clock)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("stores who and when, expires in 30 days, audits, and re-scores at once", async () => {
    const before = (await getAccountHealth(owner, accountId, clock))!.snapshot!;
    expect(before.riskLevel).toBe("HEALTHY");
    await setPulse(owner, accountId, { value: "WORRIED", comment: "New VP is skeptical" }, clock);
    const db = scopedDb(admin);
    const p = await db.csmPulse.findFirstOrThrow({ where: { accountId } });
    expect(p).toMatchObject({
      value: "WORRIED",
      comment: "New VP is skeptical",
      membershipId: owner.membershipId,
    });
    expect(p.expiresAt.getTime() - p.createdAt.getTime()).toBe(30 * 86_400_000);
    expect(
      await db.auditLog.count({ where: { action: "health.pulse_set", targetId: accountId } }),
    ).toBe(1);

    const after = (await getAccountHealth(owner, accountId, clock))!;
    expect(after.snapshot!.pulseDisagreement).toBe(true);
    expect(after.pulse).toMatchObject({ value: "WORRIED", author: "Owner", valid: true });
    // The Pulse is one input: the score moves only by its 30% share of Relationship.
    expect(after.snapshot!.riskLevelExcludingPulse).toBe("HEALTHY");
    expect(after.snapshot!.overallExcludingPulse).toBe(before.overall);
    expect(after.snapshot!.overall!).toBeLessThan(before.overall!);
  });

  it("keeps history: a later Pulse is a new row, the earlier one stays", async () => {
    await setPulse(owner, accountId, { value: "FINE" }, () => new Date(`${TODAY}T16:00:00Z`));
    const rows = await scopedDb(admin).csmPulse.findMany({
      where: { accountId },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => r.value)).toEqual(["WORRIED", "FINE"]);
    expect((await getAccountHealth(owner, accountId))!.snapshot!.pulseDisagreement).toBe(false);
  });

  it("rejects an over-long comment", async () => {
    await expect(
      setPulse(owner, accountId, { value: "FINE", comment: "x".repeat(501) }, clock),
    ).rejects.toThrow();
  });
});
