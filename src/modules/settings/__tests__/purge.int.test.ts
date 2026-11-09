import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { TENANT_MODELS } from "@/lib/db/tenantModels";
import { getStorage } from "@/lib/storage";
import { createTestAdmin } from "@/test/fixtures";
import {
  cancelDeletion,
  DELETION_GRACE_DAYS,
  purgeDueWorkspaces,
  requestDeletion,
} from "../service";

/**
 * M12 B2 (test-first) — workspace deletion (§6N7, Q-10): an Admin's typed confirmation starts a
 * DELETION_GRACE_DAYS grace period (cancellable); nothing is deleted before it ends; after it the
 * purge removes every [W] row and the ws/<id>/ object prefix, leaves other workspaces untouched,
 * and keeps a non-tenant tombstone. AuditLog stays append-only except inside a due purge.
 */
const DAY = 86_400_000;
type Actor = Awaited<ReturnType<typeof createTestAdmin>>["actor"];

async function world(label: string) {
  const { actor, workspace } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const account = await db.account.create({
    data: { workspaceId: actor.workspaceId, name: `${label} Co`, tier: "MID_TOUCH" },
  });
  await db.contact.create({
    data: {
      workspaceId: actor.workspaceId,
      accountId: account.id,
      name: "C",
      email: `c-${randomUUID().slice(0, 6)}@x.example`,
    },
  });
  await db.task.create({
    data: {
      workspaceId: actor.workspaceId,
      accountId: account.id,
      title: "t",
      ownerMembershipId: actor.membershipId,
    },
  });
  await getStorage().ensureBucket();
  await getStorage().put(actor, ["files", `${randomUUID()}.txt`], "hello", "text/plain");
  return { actor, workspace };
}

/** Rows of every [W] table for one workspace, counted as the owner role under that workspace. */
async function wCount(workspaceId: string): Promise<number> {
  const sql = TENANT_MODELS.map(
    (m) => `SELECT count(*)::int AS n FROM "${m}" WHERE "workspaceId" = $1`,
  ).join(" UNION ALL ");
  const rows = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx.$queryRawUnsafe<Array<{ n: number }>>(sql, workspaceId);
  });
  return rows.reduce((s, r) => s + Number(r.n), 0);
}

let doomed: Awaited<ReturnType<typeof world>>;
let survivor: Awaited<ReturnType<typeof world>>;
let requestedAt: Date;

beforeAll(async () => {
  doomed = await world("PurgeA");
  survivor = await world("PurgeB");
});

describe("workspace deletion", () => {
  it("needs the Admin's typed workspace name", async () => {
    await expect(requestDeletion(doomed.actor, { confirmName: "wrong" })).rejects.toThrow(
      /type the workspace name/i,
    );
    expect(
      (await rawDb.workspace.findUniqueOrThrow({ where: { id: doomed.actor.workspaceId } }))
        .deletionRequestedAt,
    ).toBeNull();
  });

  it("a non-admin cannot request deletion", async () => {
    const csm = { ...doomed.actor, role: "CSM" as const };
    await expect(requestDeletion(csm, { confirmName: doomed.workspace.name })).rejects.toThrow();
  });

  it("can be requested and cancelled during the grace period", async () => {
    const t0 = new Date(Date.now() - 60 * DAY);
    await requestDeletion(survivor.actor, { confirmName: survivor.workspace.name }, () => t0);
    await cancelDeletion(survivor.actor, () => new Date(+t0 + DAY));
    expect(
      (await rawDb.workspace.findUniqueOrThrow({ where: { id: survivor.actor.workspaceId } }))
        .deletionRequestedAt,
    ).toBeNull();
    // A cancelled request is never purged, however much later the job runs.
    await purgeDueWorkspaces();
    expect(await wCount(survivor.actor.workspaceId)).toBeGreaterThan(0);
  });

  it("deletes nothing before the grace period ends", async () => {
    // Time travel by requesting in the past: the AuditLog guard checks the DATABASE clock.
    requestedAt = new Date(Date.now() - (DELETION_GRACE_DAYS - 1) * DAY);
    const res = await requestDeletion(
      doomed.actor,
      { confirmName: doomed.workspace.name },
      () => requestedAt,
    );
    expect(res.purgeAfter.getTime()).toBe(requestedAt.getTime() + DELETION_GRACE_DAYS * DAY);
    const before = await wCount(doomed.actor.workspaceId);
    expect((await purgeDueWorkspaces()).purged).not.toContain(doomed.actor.workspaceId);
    expect(await wCount(doomed.actor.workspaceId)).toBe(before);
  });

  it("AuditLog stays append-only outside a due purge", async () => {
    await expect(
      rawDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${doomed.actor.workspaceId}, true)`;
        return tx.auditLog.deleteMany({ where: { workspaceId: doomed.actor.workspaceId } });
      }),
    ).rejects.toThrow(/append-only/);
  });

  it("after the grace period: zero [W] rows, empty object prefix, tombstone kept, others untouched", async () => {
    // Re-request (same workspace) a full grace period plus a day in the past.
    requestedAt = new Date(Date.now() - (DELETION_GRACE_DAYS + 1) * DAY);
    await requestDeletion(doomed.actor, { confirmName: doomed.workspace.name }, () => requestedAt);
    const survivorBefore = await wCount(survivor.actor.workspaceId);
    const out = await purgeDueWorkspaces();
    expect(out.purged).toContain(doomed.actor.workspaceId);
    expect(await wCount(doomed.actor.workspaceId)).toBe(0);
    expect(
      await rawDb.workspace.findUnique({ where: { id: doomed.actor.workspaceId } }),
    ).toBeNull();
    expect(await getStorage().listKeys(doomed.actor)).toEqual([]);
    const tomb = await rawDb.workspaceTombstone.findUniqueOrThrow({
      where: { workspaceId: doomed.actor.workspaceId },
    });
    expect(tomb.purgedAt).not.toBeNull();
    expect(tomb.requestedAt.getTime()).toBe(requestedAt.getTime());
    expect(await wCount(survivor.actor.workspaceId)).toBe(survivorBefore);
    expect((await getStorage().listKeys(survivor.actor)).length).toBeGreaterThan(0);
    // Q-91: personal data of users left in no workspace is deleted on purge
    expect(
      await rawDb.user.findUnique({ where: { id: doomed.actor.userId } }),
    ).toBeNull();
    expect(
      await rawDb.user.findUnique({ where: { id: survivor.actor.userId } }),
    ).not.toBeNull();
  });

  it("is idempotent: a second run purges nothing more", async () => {
    const out = await purgeDueWorkspaces();
    expect(out.purged).not.toContain(doomed.actor.workspaceId);
  });
});

export type { Actor };
