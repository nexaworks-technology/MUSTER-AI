import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";

/**
 * M12 A5 (Q-54, test-first). A read or write through ANOTHER scoped client while a tenant
 * transaction is open must run inside that transaction — same connection, workspace set, sees the
 * transaction's own uncommitted writes. Before M12 it ran on a different pooled connection with no
 * workspace setting, so RLS silently returned nothing (the M5 tier-band bug).
 */
let ws: string;
beforeAll(async () => {
  ws = (await createTestAdmin("NestedScoped")).actor.workspaceId;
});

describe("scopedDb inside a tenant transaction (Q-54)", () => {
  it("a nested scoped read sees committed rows of the workspace", async () => {
    const outer = scopedDb({ workspaceId: ws });
    const account = await outer.account.create({
      data: { workspaceId: ws, name: `N ${randomUUID().slice(0, 6)}`, tier: "MID_TOUCH" },
    });
    const seen = await outer.$tenantTransaction(async () =>
      scopedDb({ workspaceId: ws }).account.findFirst({ where: { id: account.id } }),
    );
    expect(seen?.id).toBe(account.id);
  });

  it("a nested scoped read sees the transaction's own uncommitted write", async () => {
    const outer = scopedDb({ workspaceId: ws });
    const name = `U ${randomUUID().slice(0, 6)}`;
    const seen = await outer.$tenantTransaction(async (tx) => {
      await tx.account.create({ data: { workspaceId: ws, name, tier: "LONG_TAIL" } });
      return scopedDb({ workspaceId: ws }).account.count({ where: { name } });
    });
    expect(seen).toBe(1);
  });

  it("a nested scoped write joins the transaction and rolls back with it", async () => {
    const outer = scopedDb({ workspaceId: ws });
    const name = `R ${randomUUID().slice(0, 6)}`;
    await expect(
      outer.$tenantTransaction(async () => {
        await scopedDb({ workspaceId: ws }).account.create({
          data: { workspaceId: ws, name, tier: "LONG_TAIL" },
        });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await outer.account.count({ where: { name } })).toBe(0);
  });

  it("a nested scoped raw query runs under the transaction's workspace", async () => {
    const outer = scopedDb({ workspaceId: ws });
    const setting = await outer.$tenantTransaction(async () =>
      scopedDb({ workspaceId: ws }).$queryRaw<Array<{ w: string }>>`SELECT current_setting('app.workspace_id', true) AS w`,
    );
    expect(setting[0]?.w).toBe(ws);
  });

  it("a nested client for another workspace is still refused", async () => {
    const other = (await createTestAdmin("NestedScopedB")).actor.workspaceId;
    await expect(
      scopedDb({ workspaceId: ws }).$tenantTransaction(async () =>
        scopedDb({ workspaceId: other }).account.count(),
      ),
    ).rejects.toThrow(/another workspace/);
  });
});
