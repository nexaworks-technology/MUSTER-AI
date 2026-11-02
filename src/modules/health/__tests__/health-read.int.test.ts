import { beforeAll, describe, expect, it } from "vitest";
import { addDays, utcMidnight } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { listAccounts } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { getAccountHealth, getActiveModel, healthForAccounts, scoreAndStore } from "../service";

/**
 * Account 360 › Health reads (M3 slice 8): RBAC by book (M3 rule 11), every stored reason's
 * sources resolve to a link (M3 rule 2), and the list can filter by health band.
 */
const ASOF = "2026-11-02";
let admin: Actor;
let csm: Actor;
let accountId: string;

beforeAll(async () => {
  admin = (await createTestAdmin("HealthRead")).actor;
  const db = scopedDb(admin);
  const ws = admin.workspaceId;
  const user = await db.user.create({ data: { email: `csm-${ws}@example.test`, name: "C" } });
  const m = await db.membership.create({ data: { workspaceId: ws, userId: user.id, role: "CSM" } });
  csm = {
    ...admin,
    userId: user.id,
    membershipId: m.id,
    role: "CSM",
    canViewRevenue: false,
    bookScope: "OWN",
  };
  accountId = (
    await db.account.create({
      data: {
        workspaceId: ws,
        name: "Read me",
        tier: "MID_TOUCH",
        plan: "Growth",
        ownerMembershipId: admin.membershipId,
      },
    })
  ).id;
  const a = { workspaceId: ws, accountId };
  await db.usageDaily.createMany({
    data: Array.from({ length: 120 }, (_, i) => ({
      ...a,
      date: utcMidnight(addDays(ASOF, -120 + i)),
      activeUsers: i > 100 ? 4 : 30,
      sessions: 0,
      events: 0,
    })),
  });
  const contact = await db.contact.create({ data: { ...a, name: "Pat", status: "BOUNCED" } });
  await db.stakeholderRole.create({
    data: { ...a, contactId: contact.id, role: "CHAMPION", validFrom: new Date("2025-01-01") },
  });
  await db.ticket.create({
    data: {
      ...a,
      subject: "Broken",
      priority: "URGENT",
      openedAt: new Date("2026-10-01T10:00:00Z"),
      isEscalated: true,
    },
  });
  await scoreAndStore(admin, [accountId], ASOF, await getActiveModel(admin), { makeCurrent: true });
});

describe("health reads", () => {
  it("shows the score with every source resolved to a link", async () => {
    const h = (await getAccountHealth(admin, accountId))!;
    expect(h.snapshot?.riskLevel).toBe("AT_RISK");
    expect(h.snapshot?.riskReasonId).toBeTruthy();
    const sources = h.snapshot!.reasons.flatMap((r) => r.sources);
    expect(sources.length).toBeGreaterThan(5);
    expect(sources.filter((s) => s.missing)).toEqual([]);
    expect(sources.every((s) => s.href?.startsWith(`/accounts/${accountId}/`))).toBe(true);
    expect(h.model.proposedBy).toBe("SYSTEM_DEFAULT");
  });

  it("is a 404 (null) for a CSM whose book does not include the account", async () => {
    expect(await getAccountHealth(csm, accountId)).toBeNull();
  });

  it("feeds the Accounts list and its health filter", async () => {
    const h = await healthForAccounts(admin, [accountId]);
    expect(h.get(accountId)).toMatchObject({ riskLevel: "AT_RISK" });
    const atRisk = await listAccounts(admin, { health: "AT_RISK" } as never);
    expect(atRisk.rows.map((r) => r.id)).toContain(accountId);
    const healthy = await listAccounts(admin, { health: "HEALTHY" } as never);
    expect(healthy.rows.map((r) => r.id)).not.toContain(accountId);
  });
});
