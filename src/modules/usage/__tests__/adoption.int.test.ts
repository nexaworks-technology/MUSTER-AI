import { describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { AccountNotFoundError } from "@/modules/accounts/service";
import { getAdoption } from "../service";

/** The Adoption tab's service on real rows: the CS sentences, and book scope (a CSM outside it gets 404). */
describe("getAdoption", () => {
  it("reads the plan's features, seats and trend from the database; a CSM outside the book is refused", async () => {
    const { actor, workspace } = await createTestAdmin("Adoption");
    const ws = actor.workspaceId;
    const db = scopedDb(actor);
    const account = await db.account.create({
      data: { workspaceId: ws, name: "Pinecrest", tier: "MID_TOUCH", plan: "Growth" },
    });
    await db.contract.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        startDate: new Date("2026-09-30"),
        seatsPurchased: 15,
        currency: "USD",
      },
    });
    await db.featureCatalog.createMany({
      data: ["dashboards", "data_connectors", "alerts"].map((k) => ({
        workspaceId: ws,
        featureKey: k,
        label: k,
        isKeyFeature: k !== "alerts",
        includedInPlans: ["Growth"],
      })),
    });
    await db.usageDaily.createMany({
      data: Array.from({ length: 14 }, (_, i) => ({
        workspaceId: ws,
        accountId: account.id,
        date: new Date(Date.UTC(2026, 9, 19 + i)),
        activeUsers: 3,
        sessions: 3,
        events: 9,
        seatsUsed: 3,
      })),
    });
    await db.featureUsageDaily.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        featureKey: "dashboards",
        date: new Date("2026-10-20"),
        users: 2,
        events: 4,
      },
    });
    const a = await getAdoption(actor, account.id, () => new Date("2026-11-02T17:00:00Z"));
    expect(a.features?.text).toBe("2 of 3 features in your Growth plan have never been used");
    expect(a.seats?.text).toBe("3 of 15 seats in use (20%)");
    expect(a.trend?.current).toBe(3);

    const user = await rawDb.user.create({
      data: { email: `csm-${ws}@x.test`, name: "Other CSM" },
    });
    const m = await rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
      return tx.membership.create({
        data: { workspaceId: ws, userId: user.id, role: "CSM", bookScope: "OWN" },
      });
    });
    await expect(
      getAdoption(
        { ...actor, userId: user.id, membershipId: m.id, role: "CSM", bookScope: "OWN" },
        account.id,
      ),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });
});
