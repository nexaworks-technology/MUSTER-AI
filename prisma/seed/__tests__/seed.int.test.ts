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
