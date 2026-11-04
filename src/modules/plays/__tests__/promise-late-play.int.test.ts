import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { validatePlaySafety } from "../safety";
import { SEEDED_PLAYS } from "../seeded/definitions";
import { seedPlaysForWorkspace } from "../seeded/seed";
import { processPlaySignalOpened } from "../runner";
import { publishPlay } from "../service";

/** M9 acceptance #18: Promise Late is live on its detector; Champion Loss still passes; both stay DRAFT until a human publishes. */
describe("Promise Late and Champion Loss (M9 #18)", () => {
  it("both pass the safety check, neither is dormant", async () => {
    for (const key of ["promise-late", "champion-loss"]) {
      const play = SEEDED_PLAYS.find((p) => p.key === key)!;
      expect(play.isDormant).toBeFalsy();
      const res = await validatePlaySafety(play.definition);
      expect({ key, passed: res.passed, refusals: res.refusals }).toEqual({ key, passed: true, refusals: [] });
    }
  });

  it("is seeded DRAFT, publishes when a human says so, and then enters on a promise_late signal", async () => {
    const { workspace, actor, membership } = await createTestAdmin("PromiseLatePlay");
    const db = scopedDb(actor);
    await seedPlaysForWorkspace(workspace.id);
    const play = await db.play.findFirstOrThrow({ where: { key: "promise-late" } });
    expect(play.status).toBe("DRAFT");
    const account = await db.account.create({
      data: { workspaceId: workspace.id, name: "Halden", tier: "MID_TOUCH", ownerMembershipId: membership.id },
    });
    const signal = await db.signal.create({
      data: {
        workspaceId: workspace.id, accountId: account.id, ruleKey: "promise_late", ruleVersion: 1, category: "PROMISES",
        severity: "WARN", polarity: "RISK", status: "OPEN", title: "Promise late", explanation: "x", evidence: [{ sourceType: "Promise", sourceId: "p1", date: "2026-10-24" }], values: {},
        params: {}, dedupeKey: `promise_late:${account.id}:p1`, episode: 1, firstSeenAt: new Date(), lastSeenAt: new Date(),
      },
    });
    // Before publishing, nothing enters.
    expect(await processPlaySignalOpened({ workspaceId: workspace.id, accountId: account.id, signalId: signal.id, ruleKey: "promise_late" })).toEqual({ entered: [] });
    const pub = await publishPlay(actor, play.id);
    expect(pub.status).toBe("PUBLISHED");
    const r = await processPlaySignalOpened({ workspaceId: workspace.id, accountId: account.id, signalId: signal.id, ruleKey: "promise_late" });
    expect(r.entered).toEqual([play.id]);
  });
});
