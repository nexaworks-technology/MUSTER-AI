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
