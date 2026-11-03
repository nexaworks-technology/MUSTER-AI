import { afterAll, describe, expect, it, vi } from "vitest";
import { fixedClock } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { closeQueues } from "@/lib/jobs/queues";
import { createTestAdmin } from "@/test/fixtures";
import { sealCredentials } from "../../../credentials";
import { createFixtureTransport, loadFixture } from "../../../fixture-transport";
import { runSync } from "../../../sync.jobs";

/** Mixpanel on the database, fixture transport only: sync twice changes nothing (M5 rule 2). */
vi.hoisted(() => {
  process.env.QUEUE_PREFIX = "nexaworks-mixpanel-test";
});
afterAll(() => closeQueues());

const TODAY = fixedClock("2026-11-02T15:00:00Z");

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const ws = actor.workspaceId;
  const db = scopedDb(actor);
  const pine = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Pinecrest Health",
      domain: "pinecrest-health.test",
      tier: "MID_TOUCH",
    },
  });
  await db.contact.create({
    data: {
      workspaceId: ws,
      accountId: pine.id,
      name: "U1",
      email: "u-pine-1@pinecrest-health.test",
    },
  });
  const integration = await db.integration.create({
    data: {
      workspaceId: ws,
      provider: "MIXPANEL",
      credentialsEnc: sealCredentials({
        username: "larkspur-sa.test",
        apiKey: "test_fixture_mp_secret",
      }),
      config: { projectId: "3412345" },
    },
  });
  return { actor, db, pine, integration };
}

describe("Mixpanel on the database (fixture transport)", () => {
  it("sync twice: the second run changes nothing, and unmatched groups are listed", async () => {
    const S = await setup("MpTwice");
    const world = () => createFixtureTransport(loadFixture("mixpanel", "export"));
    const p = (runKey: string) => ({
      workspaceId: S.actor.workspaceId,
      integrationId: S.integration.id,
      kind: "FULL" as const,
      trigger: "MANUAL" as const,
      runKey,
    });
    const deps = { transport: world, clock: TODAY, businessClock: TODAY };
    const first = await runSync(p("one"), deps);
    expect(first).toMatchObject({ status: "SUCCEEDED", counts: { created: 3, unmatched: 1 } });
    const snap = async () =>
      JSON.stringify([
        await S.db.usageDaily.findMany({ orderBy: { date: "asc" } }),
        await S.db.userUsageDaily.findMany({
          orderBy: [{ date: "asc" }, { externalUserId: "asc" }],
        }),
        await S.db.featureUsageDaily.findMany({
          orderBy: [{ date: "asc" }, { featureKey: "asc" }],
        }),
      ]);
    const before = await snap();
    const second = await runSync(p("two"), { ...deps, transport: world });
    expect(second.counts).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(await snap()).toBe(before);
    // What landed: provider-owned rows, dated and counted from the export.
    const days = await S.db.usageDaily.findMany({ orderBy: { date: "asc" } });
    expect(
      days.map((d) => [d.date.toISOString().slice(0, 10), d.events, d.activeUsers, d.source]),
    ).toEqual([
      ["2026-10-29", 3, 2, "MIXPANEL"],
      ["2026-10-30", 3, 2, "MIXPANEL"],
      ["2026-11-02", 1, 1, "MIXPANEL"],
    ]);
    expect(
      (await S.db.userUsageDaily.findFirstOrThrow({ where: { externalUserId: "u-pine-1" } }))
        .source,
    ).toBe("MIXPANEL");
    const job = await S.db.syncJob.findFirstOrThrow({ where: { runKey: "one" } });
    expect(JSON.stringify(job.counts)).toContain("matched no single account");
    expect(job.cursor).toBe("2026-11-02");
  });

  it("another source's day is left alone (and counted as skipped), never overwritten", async () => {
    const S = await setup("MpOwned");
    await S.db.usageDaily.create({
      data: {
        workspaceId: S.actor.workspaceId,
        accountId: S.pine.id,
        date: new Date("2026-10-29T00:00:00Z"),
        activeUsers: 7,
        sessions: 7,
        events: 77,
        source: "USAGE_API",
      },
    });
    const out = await runSync(
      {
        workspaceId: S.actor.workspaceId,
        integrationId: S.integration.id,
        kind: "FULL",
        trigger: "MANUAL",
        runKey: "own",
      },
      {
        transport: () => createFixtureTransport(loadFixture("mixpanel", "export")),
        clock: TODAY,
        businessClock: TODAY,
      },
    );
    expect(out.counts!.conflicts).toBe(1);
    const day = await S.db.usageDaily.findFirstOrThrow({
      where: { date: new Date("2026-10-29T00:00:00Z") },
    });
    expect({ events: day.events, source: day.source }).toEqual({ events: 77, source: "USAGE_API" });
  });
});
