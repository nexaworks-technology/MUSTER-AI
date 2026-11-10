import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { getActiveModel, healthOverview, listUnscoredAccounts } from "../service";

/**
 * FIX-2026-11-11 item 3. Accounts with no health score must be listed with the reason, never
 * silently absent. Lost accounts are not scored by design (every nightly path skips them), and
 * the reason says so. An active account with no snapshot yet says it is awaiting its first score.
 */
describe("Unscored accounts are listed with a reason (FIX-2026-11-11, item 3)", () => {
  it("lists lost accounts as not scored by design, and active unscored accounts as awaiting", async () => {
    const { workspace, actor } = await createTestAdmin("Unscored");
    const db = scopedDb(actor);
    const mk = (name: string, data: Record<string, unknown> = {}) =>
      db.account.create({ data: { workspaceId: workspace.id, name, tier: "MID_TOUCH", ...data } });
    const lost = await mk("Gone Co", {
      lifecycleStage: "LOST",
      churnedAt: new Date("2026-09-30T00:00:00Z"),
    });
    const lostNoDate = await mk("Gone Quietly", { lifecycleStage: "LOST" });
    const fresh = await mk("Fresh Co", { lifecycleStage: "ONBOARDING" });
    await mk("Archived Co", {
      lifecycleStage: "LOST",
      archivedAt: new Date("2026-10-01T00:00:00Z"),
    });

    const list = await listUnscoredAccounts(actor);
    const byId = new Map(list.map((u) => [u.accountId, u]));

    expect(byId.get(lost.id)).toMatchObject({
      name: "Gone Co",
      kind: "LOST",
      churnedAt: "2026-09-30",
    });
    expect(byId.get(lost.id)!.reason).toMatch(/lost/i);
    expect(byId.get(lost.id)!.reason).toMatch(/only calculated for active customers/i);
    expect(byId.get(lostNoDate.id)).toMatchObject({ kind: "LOST", churnedAt: null });
    expect(byId.get(fresh.id)).toMatchObject({ name: "Fresh Co", kind: "AWAITING_FIRST_SCORE" });
    expect(byId.get(fresh.id)!.reason).toMatch(/not been scored/i);
    // Archived accounts are out of every list; nothing is listed twice.
    expect(list.map((u) => u.name)).not.toContain("Archived Co");
    expect(new Set(list.map((u) => u.accountId)).size).toBe(list.length);
  });

  it("agrees with the Health page's own 'not scored yet' count (active accounts only)", async () => {
    const { workspace, actor } = await createTestAdmin("UnscoredCount");
    const db = scopedDb(actor);
    for (const [name, stage] of [
      ["A", "ADOPTING"],
      ["B", "ONBOARDING"],
      ["C", "LOST"],
      ["D", "LOST"],
    ] as const)
      await db.account.create({
        data: { workspaceId: workspace.id, name, tier: "MID_TOUCH", lifecycleStage: stage },
      });
    // The default model is created lazily on first use; take it first so the two reads below do
    // not race to create it (a separate, pre-existing behaviour, noted in docs/FIX-2026-11-11.md).
    await getActiveModel(actor);
    const [list, overview] = await Promise.all([
      listUnscoredAccounts(actor),
      healthOverview(actor),
    ]);
    expect(list.filter((u) => u.kind === "AWAITING_FIRST_SCORE")).toHaveLength(overview.unscored);
    expect(list.filter((u) => u.kind === "LOST")).toHaveLength(2);
    expect(list).toHaveLength(4); // every account without a score is accounted for
  });
});
