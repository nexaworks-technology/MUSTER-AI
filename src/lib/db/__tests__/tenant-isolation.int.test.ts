import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, TenantViolationError } from "@/lib/db/scoped";
import { createTestWorkspace } from "@/test/fixtures";

/**
 * Rule 2: cross-tenant access must be impossible by construction. These tests try to break it
 * through every path available in M1. Every new [W] model is added here in its milestone.
 */
let A: Awaited<ReturnType<typeof setup>>;
let B: Awaited<ReturnType<typeof setup>>;

async function setup(label: string) {
  const { workspace, user } = await createTestWorkspace(label);
  const db = scopedDb({ workspaceId: workspace.id });
  const workspaceId = workspace.id;
  const membership = await db.membership.create({
    data: { workspaceId, userId: user.id, role: "ADMIN", canViewRevenue: true },
  });
  const invitation = await db.invitation.create({
    data: {
      workspaceId,
      email: `invitee-${label}@example.test`,
      role: "CSM",
      tokenHash: `hash-${label}-${workspace.id}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      invitedByMembershipId: membership.id,
    },
  });
  const settings = await db.workspaceSettings.create({
    data: { workspaceId, data: { note: label } },
  });
  const audit = await db.auditLog.create({
    data: { workspaceId, actorType: "SYSTEM", action: "test.seeded", summary: `seeded ${label}` },
  });
  return { workspace, user, db, membership, invitation, settings, audit };
}

beforeAll(async () => {
  A = await setup("TenantA");
  B = await setup("TenantB");
});

describe("tenant isolation (Rule 2)", () => {
  it("1. reads through A's client never return B's rows, for every [W] model", async () => {
    const delegates = [
      A.db.membership,
      A.db.invitation,
      A.db.workspaceSettings,
      A.db.auditLog,
    ] as const;
    for (const delegate of delegates) {
      // Each delegate has a different row type; only workspaceId is read here.
      const rows = (await (delegate as typeof A.db.membership).findMany()) as Array<{
        workspaceId: string;
      }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.workspaceId === A.workspace.id)).toBe(true);
    }
    expect(await A.db.membership.findFirst({ where: { id: B.membership.id } })).toBeNull();
    expect(await A.db.membership.findUnique({ where: { id: B.membership.id } })).toBeNull();
    expect(await A.db.invitation.count({ where: { id: B.invitation.id } })).toBe(0);
    expect(await A.db.auditLog.count({ where: { id: B.audit.id } })).toBe(0);
  });

  it("2. updates and deletes through A with B's ids change nothing", async () => {
    await expect(
      A.db.membership.update({ where: { id: B.membership.id }, data: { role: "VIEWER" } }),
    ).rejects.toMatchObject({ code: "P2025" });
    const many = await A.db.membership.updateMany({
      where: { id: B.membership.id },
      data: { role: "VIEWER" },
    });
    expect(many.count).toBe(0);
    await expect(A.db.invitation.delete({ where: { id: B.invitation.id } })).rejects.toMatchObject({
      code: "P2025",
    });
    expect((await A.db.invitation.deleteMany({ where: { id: B.invitation.id } })).count).toBe(0);

    const stillThere = await B.db.membership.findUnique({ where: { id: B.membership.id } });
    expect(stillThere?.role).toBe("ADMIN");
  });

  it("3. passing B's workspaceId to A's client throws", async () => {
    await expect(
      A.db.membership.findMany({ where: { workspaceId: B.workspace.id } }),
    ).rejects.toBeInstanceOf(TenantViolationError);
    await expect(
      A.db.auditLog.create({
        data: { workspaceId: B.workspace.id, actorType: "SYSTEM", action: "x", summary: "x" },
      }),
    ).rejects.toBeInstanceOf(TenantViolationError);
    await expect(
      A.db.membership.update({
        where: { id: A.membership.id },
        data: { workspaceId: B.workspace.id },
      }),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("4. raw SQL as app_user without app.workspace_id sees no tenant rows (RLS)", async () => {
    const rows = await rawDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Membership"`;
    expect(Number(rows[0]?.n)).toBe(0);
    const audit = await rawDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "AuditLog"`;
    expect(Number(audit[0]?.n)).toBe(0);
  });

  it("4b. RLS WITH CHECK blocks writing another workspace's rows even inside A's setting", async () => {
    await expect(
      rawDb.$transaction([
        rawDb.$executeRaw`SELECT set_config('app.workspace_id', ${A.workspace.id}, true)`,
        rawDb.$executeRaw`INSERT INTO "AuditLog" (id, "workspaceId", "actorType", action, summary)
          VALUES (${`x-${B.workspace.id}`}, ${B.workspace.id}, 'SYSTEM', 'x', 'x')`,
      ]),
    ).rejects.toThrow(/row-level security/);
  });

  it("5. a composite-FK insert referencing B's parent from A fails", async () => {
    await expect(
      A.db.invitation.create({
        data: {
          workspaceId: A.workspace.id,
          email: "cross@example.test",
          role: "CSM",
          tokenHash: `cross-${A.workspace.id}`,
          expiresAt: new Date(Date.now() + 86_400_000),
          invitedByMembershipId: B.membership.id,
        },
      }),
    ).rejects.toSatisfy(
      (e) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003",
    );
  });

  it("6. $queryRawUnsafe and $executeRawUnsafe are refused on the scoped client", async () => {
    await expect(A.db.$queryRawUnsafe("SELECT 1")).rejects.toBeInstanceOf(TenantViolationError);
    await expect(A.db.$executeRawUnsafe("SELECT 1")).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("creates through A accept A's own workspaceId", async () => {
    const row = await A.db.auditLog.create({
      data: { workspaceId: A.workspace.id, actorType: "SYSTEM", action: "t", summary: "own" },
    });
    expect(row.workspaceId).toBe(A.workspace.id);
  });

  it("tagged raw SQL on the scoped client runs inside the workspace setting", async () => {
    const rows = await A.db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Membership"`;
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("interactive tenant transactions stay scoped", async () => {
    const count = await A.db.$tenantTransaction(async (tx) => {
      await tx.auditLog.create({
        data: { workspaceId: A.workspace.id, actorType: "SYSTEM", action: "tx", summary: "in tx" },
      });
      return tx.membership.count();
    });
    expect(count).toBe(1);
    await expect(
      A.db.$tenantTransaction((tx) =>
        tx.membership.findMany({ where: { workspaceId: B.workspace.id } }),
      ),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });
});
