import { afterAll, describe, expect, it, vi } from "vitest";
import { fixedClock } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { closeQueues } from "@/lib/jobs/queues";
import { createTestAdmin } from "@/test/fixtures";
import { sealCredentials } from "../../../credentials";
import { createFixtureTransport, loadFixture } from "../../../fixture-transport";
import { runSync } from "../../../sync.jobs";

/** Amplitude on the database, fixture transport only: sync twice changes nothing (M5 rule 2). */
vi.hoisted(() => {
  process.env.QUEUE_PREFIX = "nexaworks-amplitude-test";
});
afterAll(() => closeQueues());

const TODAY = fixedClock("2026-11-02T15:00:00Z");

describe("Amplitude on the database (fixture transport)", () => {
  it("sync twice: the second run changes nothing; account and feature days land, people do not", async () => {
    const { actor } = await createTestAdmin("AmTwice");
    const db = scopedDb(actor);
    const ws = actor.workspaceId;
    await db.account.create({
      data: {
        workspaceId: ws,
        name: "Pinecrest Health",
        domain: "pinecrest-health.test",
        tier: "MID_TOUCH",
      },
    });
    const integration = await db.integration.create({
      data: {
        workspaceId: ws,
        provider: "AMPLITUDE",
        credentialsEnc: sealCredentials({
          username: "test-fixture-key",
          apiKey: "test_fixture_am_secret",
        }),
        config: {
          features: { dashboards: "Dashboard Viewed", data_connectors: "Data Connector Added" },
        },
      },
    });
    const world = () => createFixtureTransport(loadFixture("amplitude", "segmentation"));
    const p = (runKey: string) => ({
      workspaceId: ws,
      integrationId: integration.id,
      kind: "FULL" as const,
      trigger: "MANUAL" as const,
      runKey,
    });
    const deps = { transport: world, clock: TODAY, businessClock: TODAY };
    const first = await runSync(p("one"), deps);
    expect(first).toMatchObject({ status: "SUCCEEDED", counts: { created: 3, unmatched: 1 } });
    const snap = async () =>
      JSON.stringify([
        await db.usageDaily.findMany({ orderBy: { date: "asc" } }),
        await db.featureUsageDaily.findMany({ orderBy: [{ date: "asc" }, { featureKey: "asc" }] }),
      ]);
    const before = await snap();
    const second = await runSync(p("two"), { ...deps, transport: world });
    expect(second.counts).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(await snap()).toBe(before);
    expect(await db.userUsageDaily.count()).toBe(0);
    const features = await db.featureUsageDaily.findMany({
      orderBy: [{ date: "asc" }, { featureKey: "asc" }],
    });
    expect(features.map((f) => [f.featureKey, f.users, f.events, f.source])).toEqual([
      ["dashboards", 1, 1, "AMPLITUDE"],
      ["data_connectors", 1, 1, "AMPLITUDE"],
      ["dashboards", 2, 2, "AMPLITUDE"],
    ]);
  });
});
