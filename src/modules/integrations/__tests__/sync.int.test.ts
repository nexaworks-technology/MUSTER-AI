import { Worker, type Job } from "bullmq";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { closeQueues, getQueue, queuePrefix, redisConnection } from "@/lib/jobs/queues";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { createPipelineProcessors } from "@/modules/signals/service";
import type { IntegrationAdapter } from "../adapter";
import type { ConnectionDeps } from "../connection";
import { sealCredentials } from "../credentials";
import { describeProviderError } from "../errors";
import {
  createFixtureTransport,
  type FixtureInteraction,
  type FixtureTransport,
} from "../fixture-transport";
import { runSync } from "../sync.jobs";
import { requestJson } from "../transport";

/**
 * M5 §5 sync tests: cursor resume, a failed page that records errorPlain and keeps the cursor,
 * idempotent re-runs, plain credential errors, unfixtured requests surfacing, and the nightly
 * kickoff waiting on sync.run children through the real queue (M5 rule 7).
 */
vi.hoisted(() => {
  process.env.QUEUE_PREFIX = "nexaworks-sync-test";
});

const page = z.object({
  results: z.array(z.object({ id: z.string(), name: z.string() })),
  next: z.string().nullable(),
});

/** A minimal CRM-shaped adapter over the fixture transport: GET /items?after=<cursor>. */
const fakeAdapter: IntegrationAdapter<Record<string, never>> = {
  provider: "HUBSPOT",
  category: "CRM",
  displayName: "Fake CRM",
  configSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  auth: { kind: "apiKey", validate: async () => {} },
  testConnection: async () => ({ ok: true, message: "ok" }),
  async *sync(ctx, opts) {
    let after = opts.cursor;
    for (;;) {
      const url = new URL("https://fake.test/items");
      if (after) url.searchParams.set("after", after);
      const body = await requestJson(ctx.transport, { method: "GET", url: url.toString() }, page);
      const last = body.results.at(-1)?.id ?? after;
      yield {
        kind: "accounts",
        records: body.results.map((r) => ({ externalId: r.id, name: r.name })),
        cursor: last,
      };
      if (!body.next) return;
      after = body.next;
    }
  },
  describeError: (e) => describeProviderError(e, "Fake CRM", "Paste a new key."),
};

const get = (after: string | undefined, status: number, body: unknown): FixtureInteraction => ({
  request: { method: "GET", path: "/items", ...(after ? { query: { after } } : {}) },
  response: { status, headers: {}, body },
});

function deps(
  interactions: FixtureInteraction[],
): ConnectionDeps & { transport: () => FixtureTransport } {
  const t = createFixtureTransport(interactions);
  return { adapter: () => fakeAdapter, transport: () => t };
}

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const integration = await db.integration.create({
    data: {
      workspaceId: actor.workspaceId,
      provider: "HUBSPOT",
      credentialsEnc: sealCredentials({ apiKey: "test-key-not-real" }),
    },
  });
  const payload = (runKey: string, kind: "FULL" | "INCREMENTAL" = "INCREMENTAL") => ({
    workspaceId: actor.workspaceId,
    integrationId: integration.id,
    kind,
    trigger: "MANUAL" as const,
    runKey,
  });
  return { actor, db, integration, payload };
}

describe("sync.run", () => {
  it("a FULL run pages through, stores the cursor; INCREMENTAL resumes from it", async () => {
    const S = await setup("SyncCursor");
    const first = deps([
      get("a2", 200, { results: [{ id: "a3", name: "Three" }], next: null }),
      get(undefined, 200, {
        results: [
          { id: "a1", name: "One" },
          { id: "a2", name: "Two" },
        ],
        next: "a2",
      }),
    ]);
    const r1 = await runSync(S.payload("run-1"), first);
    expect(r1).toMatchObject({ status: "SUCCEEDED", counts: { created: 3 } });
    const job1 = await S.db.syncJob.findUniqueOrThrow({ where: { id: r1.syncJobId! } });
    expect(job1).toMatchObject({ kind: "FULL", cursorIn: null, cursor: "a3", status: "SUCCEEDED" });

    const second = deps([get("a3", 200, { results: [{ id: "a4", name: "Four" }], next: null })]);
    const r2 = await runSync(S.payload("run-2"), second);
    expect(r2).toMatchObject({ status: "SUCCEEDED", counts: { created: 1 } });
    expect(second.transport().calls.map((c) => new URL(c.url).search)).toEqual(["?after=a3"]);
    const job2 = await S.db.syncJob.findUniqueOrThrow({ where: { id: r2.syncJobId! } });
    expect(job2).toMatchObject({ kind: "INCREMENTAL", cursorIn: "a3", cursor: "a4" });
    const integ = await S.db.integration.findUniqueOrThrow({ where: { id: S.integration.id } });
    expect(integ.lastSyncAt).not.toBeNull();
  });

  it("a failed page records errorPlain, keeps no cursor, and the next run starts from the last good one", async () => {
    const S = await setup("SyncFail");
    await runSync(
      S.payload("good"),
      deps([get(undefined, 200, { results: [{ id: "b1", name: "One" }], next: null })]),
    );
    const failing = deps([
      get("b2", 503, {}),
      get("b1", 200, { results: [{ id: "b2", name: "Two" }], next: "b2" }),
    ]);
    const r = await runSync(S.payload("bad"), failing);
    expect(r).toMatchObject({
      status: "FAILED",
      errorPlain: "Fake CRM had a problem on its side (HTTP 503).",
    });
    const bad = await S.db.syncJob.findUniqueOrThrow({ where: { id: r.syncJobId! } });
    expect(bad).toMatchObject({ status: "FAILED", cursorIn: "b1", cursor: null });
    expect(bad.errorPlain).toBe(
      "Fake CRM had a problem on its side (HTTP 503). Nothing to do: the next run tries again.",
    );
    expect(await S.db.account.count()).toBe(2); // page one of the failed run still landed, once
    const integ = await S.db.integration.findUniqueOrThrow({ where: { id: S.integration.id } });
    expect(integ).toMatchObject({
      status: "CONNECTED",
      lastErrorPlain: "Fake CRM had a problem on its side (HTTP 503).",
    });

    const retry = deps([get("b1", 200, { results: [{ id: "b2", name: "Two" }], next: null })]);
    expect(await runSync(S.payload("retry"), retry)).toMatchObject({
      status: "SUCCEEDED",
      counts: { created: 0, unchanged: 1 },
    });
    expect(
      (await S.db.integration.findUniqueOrThrow({ where: { id: S.integration.id } }))
        .lastErrorPlain,
    ).toBeNull();
  });

  it("re-running the same run key does nothing the second time", async () => {
    const S = await setup("SyncTwice");
    const d = deps([get(undefined, 200, { results: [{ id: "c1", name: "One" }], next: null })]);
    expect((await runSync(S.payload("nightly-2026-11-02"), d)).status).toBe("SUCCEEDED");
    expect((await runSync(S.payload("nightly-2026-11-02"), d)).status).toBe("SKIPPED");
    expect(d.transport().calls).toHaveLength(1);
    expect(await S.db.syncJob.count()).toBe(1);
  });

  it("a rejected key marks the integration ERROR with the adapter's plain words and action", async () => {
    const S = await setup("Sync401");
    const r = await runSync(
      S.payload("x"),
      deps([get(undefined, 401, { message: "secret detail" })]),
    );
    expect(r.errorPlain).toBe("Fake CRM rejected the saved credentials.");
    const job = await S.db.syncJob.findUniqueOrThrow({ where: { id: r.syncJobId! } });
    expect(job.errorPlain).toBe("Fake CRM rejected the saved credentials. Paste a new key.");
    expect(job.errorPlain).not.toContain("secret detail");
    expect(
      (await S.db.integration.findUniqueOrThrow({ where: { id: S.integration.id } })).status,
    ).toBe("ERROR");
  });

  it("a request with no fixture is recorded and rethrown, never swallowed (M5 rule 5)", async () => {
    const S = await setup("SyncUnfixtured");
    await expect(runSync(S.payload("x"), deps([]))).rejects.toThrow(/No recorded fixture/);
  });

  it("a disconnected integration is skipped", async () => {
    const S = await setup("SyncDisconnected");
    await S.db.integration.update({
      where: { id: S.integration.id },
      data: { status: "DISCONNECTED", credentialsEnc: null },
    });
    expect((await runSync(S.payload("x"), deps([]))).status).toBe("SKIPPED");
  });
});

describe("nightly flow: kickoff waits for the syncs (real queue)", () => {
  const workers: Worker[] = [];
  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
  });

  it("sync.run children finish before the fan-out; re-running the same nightly run adds nothing", async () => {
    const S = await setup("SyncFlow");
    await S.db.account.create({
      data: { workspaceId: S.actor.workspaceId, name: "Existing", tier: "MID_TOUCH" },
    });
    const order: string[] = [];
    const evaluated: string[] = [];
    const d = deps([
      get(undefined, 200, { results: [{ id: "f1", name: "Synced Co" }], next: null }),
    ]);
    const pipeline = createPipelineProcessors({ clock: () => new Date("2026-11-02T17:00:00Z") });
    const opts = { connection: redisConnection(), prefix: queuePrefix() };
    workers.push(
      new Worker(
        "sync",
        async (job: Job) => {
          order.push(job.name);
          return runSync(job.data, d);
        },
        opts,
      ),
      new Worker(
        "signals",
        async (job: Job) => {
          order.push(`${job.name}${job.data.afterSync ? ":afterSync" : ""}`);
          if (job.name === "signals.evaluateChunk") evaluated.push(...job.data.accountIds);
          return pipeline.signals[job.name]!(job);
        },
        opts,
      ),
      new Worker("health", async (job: Job) => pipeline.health[job.name]!(job), opts),
    );
    const kick = () =>
      getQueue("signals").add(
        "nightly.kickoff",
        { workspaceId: S.actor.workspaceId, runId: "nightly-flow" },
        { jobId: `${S.actor.workspaceId}.kickoff.flow-${order.length}` },
      );
    await kick();
    const idle = async () => {
      for (let i = 0; i < 300; i++) {
        const counts = await Promise.all(
          (["signals", "health", "sync"] as const).map((q) =>
            getQueue(q).getJobCounts(
              "waiting",
              "active",
              "delayed",
              "prioritized",
              "waiting-children",
            ),
          ),
        );
        if (counts.every((c) => Object.values(c).every((n) => n === 0))) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("queues did not drain");
    };
    await idle();
    expect(order.slice(0, 3)).toEqual(["nightly.kickoff", "sync.run", "nightly.kickoff:afterSync"]);
    expect(order).toContain("signals.evaluateChunk");
    // The account the sync created was evaluated by the same nightly run.
    const synced = await S.db.account.findFirstOrThrow({ where: { name: "Synced Co" } });
    expect(evaluated).toContain(synced.id);
    // Same nightly run again: no new SyncJob, no second provider call.
    await kick();
    await idle();
    expect(await S.db.syncJob.count()).toBe(1);
    expect(d.transport().calls).toHaveLength(1);
  }, 60_000);
});
