import { describe, expect, it } from "vitest";
import { verifyPassword } from "@/lib/auth/password";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { runSeed, seedId } from "../run";
import { DEMO_PASSWORD, DEMO_USERS } from "../users";

describe("seed v0 (docs/SEED_DATA.md §2)", () => {
  it("is deterministic and idempotent: stable ids, same memberships on every run", async () => {
    const [first] = await runSeed({ includeTestTenant: true });
    const [second] = await runSeed({ includeTestTenant: true });
    expect(second!.id).toBe(first!.id);

    const members = await scopedDb({ workspaceId: first!.id }).membership.findMany({
      where: { userId: { in: DEMO_USERS.map((u) => seedId(u.key)) } },
      include: { user: true },
    });
    expect(
      members.map((m) => [m.user.email, m.role, m.canViewRevenue, m.bookScope]).sort(),
    ).toEqual(DEMO_USERS.map((u) => [u.email, u.role, u.canViewRevenue, u.bookScope]).sort());
  });

  it("gives revenue access to Priya and Dana only", async () => {
    const [ws] = await runSeed({ includeTestTenant: false });
    const withRevenue = await scopedDb({ workspaceId: ws!.id }).membership.findMany({
      where: { canViewRevenue: true, userId: { in: DEMO_USERS.map((u) => seedId(u.key)) } },
      include: { user: true },
    });
    expect(withRevenue.map((m) => m.user.name).sort()).toEqual(["Dana Whitfield", "Priya Raman"]);
  });

  it("creates the Ferngrove test tenant on request, with the dev-only password", async () => {
    await runSeed({ includeTestTenant: true });
    const ferngrove = await rawDb.workspace.findUniqueOrThrow({
      where: { slug: "ferngrove-test" },
    });
    expect(ferngrove.name).toBe("Ferngrove Software");
    const admin = await rawDb.user.findUniqueOrThrow({ where: { email: "admin@ferngrove.test" } });
    expect(await verifyPassword(admin.passwordHash!, DEMO_PASSWORD)).toBe(true);
  });
});

describe("seed v1 — accounts and people (docs/SEED_DATA.md §3)", () => {
  it("has 60 active accounts (10 high / 20 mid / 30 long-tail) and 12 churned, stable across runs", async () => {
    const [ws] = await runSeed({ includeTestTenant: true });
    const db = scopedDb({ workspaceId: ws!.id });
    const counts = async () => ({
      tiers: await db.account.groupBy({
        by: ["tier"],
        where: { lifecycleStage: { not: "LOST" }, source: "SEED" },
        _count: true,
      }),
      lost: await db.account.count({ where: { lifecycleStage: "LOST", source: "SEED" } }),
      contacts: await db.contact.count({ where: { source: "SEED" } }),
      roles: await db.stakeholderRole.count(),
    });
    const first = await counts();
    await runSeed({ includeTestTenant: true });
    expect(await counts()).toEqual(first);
    expect(Object.fromEntries(first.tiers.map((t) => [t.tier, t._count]))).toEqual({
      HIGH_TOUCH: 10,
      MID_TOUCH: 20,
      LONG_TAIL: 30,
    });
    expect(first.lost).toBe(12);
  });

  it("plants the Brightwell champion-loss story", async () => {
    const [ws] = await runSeed({ includeTestTenant: false });
    const db = scopedDb({ workspaceId: ws!.id });
    const brightwell = await db.account.findFirstOrThrow({
      where: { name: "Brightwell Logistics" },
      include: { owner: { include: { user: true } } },
    });
    expect(brightwell).toMatchObject({ tier: "HIGH_TOUCH" });
    expect(brightwell.owner?.user.name).toBe("Leo Marsh");
    const maya = await db.contact.findFirstOrThrow({
      where: { accountId: brightwell.id, name: "Maya Ortiz" },
      include: { roles: true },
    });
    expect(maya.status).toBe("BOUNCED");
    expect(maya.roles.map((r) => r.role)).toContain("CHAMPION");
    expect(maya.email).toMatch(/\.test$/);
  });

  it("gives the Ferngrove test tenant no demo data", async () => {
    await runSeed({ includeTestTenant: true });
    const ferngrove = await rawDb.workspace.findUniqueOrThrow({
      where: { slug: "ferngrove-test" },
    });
    expect(await scopedDb({ workspaceId: ferngrove.id }).account.count()).toBe(0);
  });

  it("uses only .test email domains", async () => {
    const [ws] = await runSeed({ includeTestTenant: false });
    const emails = await scopedDb({ workspaceId: ws!.id }).contact.findMany({
      where: { source: "SEED" },
      select: { email: true },
    });
    expect(emails.every((e) => e.email!.trim().toLowerCase().endsWith(".test"))).toBe(true);
  });
});

describe("seed v1 — commercial (docs/SEED_DATA.md §6)", () => {
  it("derives revenue events by rule: NEW for every contracted account, 6 expansions, 3 contractions, 12 churns", async () => {
    const [ws] = await runSeed({ includeTestTenant: false });
    const db = scopedDb({ workspaceId: ws!.id });
    const byType = Object.fromEntries(
      (
        await db.revenueEvent.groupBy({
          by: ["type"],
          where: { account: { source: "SEED" } },
          _count: true,
        })
      ).map((g) => [g.type, g._count]),
    );
    expect(byType).toMatchObject({ NEW: 71, EXPANSION: 6, CONTRACTION: 3, CHURN: 12 });
  });

  it("plants the story facts: Fairhaven has no contract, Kestrel no renewal date, Sundial failed twice", async () => {
    const [ws] = await runSeed({ includeTestTenant: false });
    const db = scopedDb({ workspaceId: ws!.id });
    const acct = (name: string) =>
      db.account.findFirstOrThrow({
        where: { name },
        include: { contracts: true, invoices: true },
      });
    const fairhaven = await acct("Fairhaven Dental Group");
    expect(fairhaven.contracts).toHaveLength(0);
    expect(fairhaven.arrMinor).toBeNull();
    const kestrel = await acct("Kestrel Robotics");
    expect(kestrel.renewalDate).toBeNull();
    expect(kestrel.arrMinor).not.toBeNull();
    const sundial = await acct("Sundial Fitness");
    expect(sundial.invoices.some((i) => i.status === "FAILED" && i.failureCount === 2)).toBe(true);
    const northgate = await acct("Northgate Freight");
    expect(
      Math.round(
        (northgate.renewalDate!.getTime() - Date.parse("2026-11-02T14:00:00Z")) / 86_400_000,
      ),
    ).toBe(41);
  });

  it("stores contract terms as ciphertext", async () => {
    const [ws] = await runSeed({ includeTestTenant: false });
    const contract = await scopedDb({ workspaceId: ws!.id }).contract.findFirstOrThrow({
      where: { source: "SEED" },
    });
    expect(contract.termsEnc).not.toMatch(/Annual subscription/);
  });
});

describe("seed v1 — usage (docs/SEED_DATA.md §4)", () => {
  const sumUsers = async (
    workspaceId: string,
    name: string,
    fromDaysAgo: number,
    toDaysAgo: number,
  ) => {
    const db = scopedDb({ workspaceId });
    const account = await db.account.findFirstOrThrow({ where: { name } });
    const day = (n: number) => new Date(Date.UTC(2026, 10, 2) - n * 86_400_000);
    const rows = await db.usageDaily.findMany({
      where: { accountId: account.id, date: { gte: day(fromDaysAgo), lte: day(toDaysAgo) } },
    });
    return rows.reduce((s, r) => s + r.activeUsers, 0);
  };

  it("Brightwell's active users fell to well under half of their normal in the last week", async () => {
    const [ws] = await runSeed({ includeTestTenant: false });
    const lastWeek = await sumUsers(ws!.id, "Brightwell Logistics", 6, 0);
    const normalWeek = await sumUsers(ws!.id, "Brightwell Logistics", 76, 70);
    expect(lastWeek / normalWeek).toBeLessThan(0.55);
  });

  it("Redfern Outdoor has had no logins for 24 days", async () => {
    const [ws] = await runSeed({ includeTestTenant: false });
    expect(await sumUsers(ws!.id, "Redfern Outdoor", 23, 0)).toBe(0);
    expect(await sumUsers(ws!.id, "Redfern Outdoor", 60, 30)).toBeGreaterThan(0);
  });

  it("Copperleaf Studios has more active people than seats bought (40)", async () => {
    const [ws] = await runSeed({ includeTestTenant: false });
    const db = scopedDb({ workspaceId: ws!.id });
    const account = await db.account.findFirstOrThrow({ where: { name: "Copperleaf Studios" } });
    const people = await db.userUsageDaily.groupBy({
      by: ["externalUserId"],
      where: { accountId: account.id, date: { gte: new Date(Date.UTC(2026, 9, 6)) } },
    });
    expect(people.length).toBe(52);
  });
});
