import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";

/**
 * Rule 2 for M12 models: ProductEvent (pilot instrumentation). Pattern as the M11 suite:
 * cross-workspace read null; cross-workspace delete changes 0; composite FK refuses another
 * workspace's membership; raw SQL without the workspace setting sees 0 rows. Plus the append-only
 * trigger: UPDATE and DELETE are refused while the workspace is live.
 */
type Side = Awaited<ReturnType<typeof setup>>;
let A: Side;
let B: Side;

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const event = await db.productEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      membershipId: actor.membershipId,
      name: "today.opened",
      occurredAt: new Date("2026-11-02T09:00:00Z"),
    },
  });
  return { actor, db, event };
}

const fk = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";

beforeAll(async () => {
  A = await setup("m12-a");
  B = await setup("m12-b");
});

describe("M12 tenant isolation (ProductEvent)", () => {
  it("A cannot read B's event", async () => {
    expect(await A.db.productEvent.findUnique({ where: { id: B.event.id } })).toBeNull();
    expect(await A.db.productEvent.findMany({})).toHaveLength(1);
  });

  it("cross-tenant update changes 0 rows; an own update is refused by the append-only trigger", async () => {
    const attack = await A.db.productEvent.updateMany({
      where: { id: B.event.id },
      data: { name: "approvals.opened" },
    });
    expect(attack.count).toBe(0);
    await expect(
      A.db.productEvent.updateMany({
        where: { id: A.event.id },
        data: { name: "approvals.opened" },
      }),
    ).rejects.toThrow(/append-only/i);
  });

  it("cross-tenant delete changes 0 rows; an own delete is refused while the workspace is live", async () => {
    expect((await A.db.productEvent.deleteMany({ where: { id: B.event.id } })).count).toBe(0);
    await expect(A.db.productEvent.deleteMany({ where: { id: A.event.id } })).rejects.toThrow(
      /append-only/i,
    );
    expect(await B.db.productEvent.findUnique({ where: { id: B.event.id } })).not.toBeNull();
  });

  it("refuses a membership from another workspace", async () => {
    await expect(
      A.db.productEvent.create({
        data: {
          workspaceId: A.actor.workspaceId,
          membershipId: B.actor.membershipId,
          name: "today.opened",
          occurredAt: new Date(),
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("raw SQL without the workspace setting sees no rows", async () => {
    const rows = await rawDb.$transaction((tx) => tx.productEvent.findMany({}));
    expect(rows).toHaveLength(0);
  });

  it("the purge path still works: once the grace has ended the rows can go with the workspace", async () => {
    const { actor } = await createTestAdmin("m12-purge");
    const db = scopedDb(actor);
    await db.productEvent.create({
      data: {
        workspaceId: actor.workspaceId,
        membershipId: actor.membershipId,
        name: "today.opened",
        occurredAt: new Date(),
      },
    });
    await rawDb.workspaceTombstone.create({
      data: {
        workspaceId: actor.workspaceId,
        workspaceSlug: `purge-${actor.workspaceId}`,
        requestedAt: new Date(Date.now() - 40 * 86_400_000),
        graceEndsAt: new Date(Date.now() - 86_400_000),
      },
    });
    await rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${actor.workspaceId}, true)`;
      await tx.auditLog.deleteMany({ where: { workspaceId: actor.workspaceId } });
      await tx.workspace.deleteMany({ where: { id: actor.workspaceId } });
    });
    expect(await rawDb.workspace.findUnique({ where: { id: actor.workspaceId } })).toBeNull();
  });
});
