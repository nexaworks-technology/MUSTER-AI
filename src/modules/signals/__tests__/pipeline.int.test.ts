import { Worker, type Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addDays, utcMidnight } from "@/lib/dates";
import { closeQueues, getQueue, queuePrefix, redisConnection } from "@/lib/jobs/queues";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { countQueries } from "@/test/query-counter";
import { createPipelineProcessors, enqueueAccountEvaluation, type PipelineDeps } from "../pipeline";

/**
 * The nightly run goes through the real queue (M3 rule 9): kickoff → evaluate chunks → score
 * chunks, processed by BullMQ workers, not by calling services directly. Its own key prefix keeps
 * it apart from other test files' jobs.
 */
vi.hoisted(() => {
  process.env.QUEUE_PREFIX = "nexaworks-pipeline-test";
});

const NOW = "2026-11-02T20:00:00Z"; // 01:30 on Nov 3 in Kolkata, 15:00 on Nov 2 in New York
let failOnce: string | null = null;
const deps: PipelineDeps = {
  clock: () => new Date(NOW),
  chunkSize: 2,
  beforeStage: (stage, data) => {
    if (failOnce && `${stage}:${data.chunk}` === failOnce) {
      failOnce = null;
      throw new Error("planned failure for the retry test");
    }
  },
};
const processors = createPipelineProcessors(deps);
let workers: Worker[] = [];

async function waitIdle() {
  for (let i = 0; i < 300; i++) {
    const counts = await Promise.all(
      (["signals", "health"] as const).map((q) =>
        getQueue(q).getJobCounts("waiting", "active", "delayed", "prioritized"),
      ),
    );
    if (counts.every((c) => Object.values(c).every((n) => n === 0))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("queues did not drain");
}

async function nightly(workspaceId: string, runId: string, asOf?: string) {
  await getQueue("signals").add(
    "nightly.kickoff",
    { workspaceId, runId, asOf },
    { jobId: `${workspaceId}.kickoff.${runId}` },
  );
  await waitIdle();
}

async function account(
  ws: string,
  name: string,
  recentUsers: number,
  extra: { renewal?: string } = {},
) {
  const db = scopedDb({ workspaceId: ws });
  const a = await db.account.create({ data: { workspaceId: ws, name, tier: "MID_TOUCH" } });
  await db.usageDaily.createMany({
    data: Array.from({ length: 120 }, (_, i) => {
      const d = 120 - i;
      return {
        workspaceId: ws,
        accountId: a.id,
        date: utcMidnight(addDays("2026-11-02", -d)),
        activeUsers: d <= 14 ? recentUsers : 40,
        sessions: 0,
        events: 0,
      };
    }),
  });
  if (extra.renewal)
    await db.contract.create({
      data: {
        workspaceId: ws,
        accountId: a.id,
        startDate: utcMidnight("2026-02-01"),
        renewalDate: utcMidnight(extra.renewal),
      },
    });
  return a.id;
}

let ws: string;
let ids: string[];

beforeAll(async () => {
  expect(queuePrefix()).toBe("nexaworks-pipeline-test");
  for (const q of ["signals", "health"] as const) await getQueue(q).obliterate({ force: true });
  workers = (["signals", "health"] as const).map(
    (q) =>
      new Worker(q, async (job: Job) => processors[q][job.name]!(job), {
        connection: redisConnection(),
        prefix: queuePrefix(),
        concurrency: 2,
      }),
  );
  ws = (await createTestAdmin("Pipeline")).actor.workspaceId;
  ids = [
    await account(ws, "Dropped A", 12),
    await account(ws, "Dropped B", 20),
    await account(ws, "Steady C", 40),
    await account(ws, "Steady D", 41),
    await account(ws, "Steady E", 39),
  ];
});

afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});

const snapshotRows = () =>
  scopedDb({ workspaceId: ws }).healthScoreSnapshot.findMany({
    where: { isBacktest: false },
    orderBy: { accountId: "asc" },
    select: { id: true, accountId: true, asOf: true, inputsHash: true, overall: true },
  });
const signalRows = () =>
  scopedDb({ workspaceId: ws }).signal.findMany({
    orderBy: { id: "asc" },
    select: { id: true, dedupeKey: true, episode: true, status: true, updatedAt: true },
  });

describe("nightly pipeline through the real queue", () => {
  it("kickoff fans out to chunks, which evaluate signals and then score health", async () => {
    await nightly(ws, "run-1", "2026-11-02");
    const snaps = await snapshotRows();
    expect(snaps).toHaveLength(5);
    expect(new Set(snaps.map((s) => s.asOf.toISOString().slice(0, 10)))).toEqual(
      new Set(["2026-11-02"]),
    );
    const signals = await signalRows();
    expect(signals.filter((s) => s.dedupeKey.startsWith("usage_drop_vs_normal")).length).toBe(2);
    const baselines = await scopedDb({ workspaceId: ws }).usageBaseline.count();
    expect(baselines).toBe(5);
    const accounts = await scopedDb({ workspaceId: ws }).account.findMany({
      select: { currentHealthSnapshotId: true },
    });
    expect(accounts.every((a) => a.currentHealthSnapshotId !== null)).toBe(true);
  });

  it("running it twice gives identical rows: no duplicate signals, no rewritten snapshots", async () => {
    const [snaps, signals] = [await snapshotRows(), await signalRows()];
    await nightly(ws, "run-2", "2026-11-02");
    expect(await snapshotRows()).toEqual(snaps);
    expect(await signalRows()).toEqual(signals);
  });

  it("a failing chunk is retried without affecting the other chunks", async () => {
    failOnce = "evaluate:1";
    await nightly(ws, "run-3", "2026-11-03");
    expect(failOnce).toBeNull();
    const snaps = await scopedDb({ workspaceId: ws }).healthScoreSnapshot.count({
      where: { asOf: utcMidnight("2026-11-03") },
    });
    expect(snaps).toBe(5);
    const job = await getQueue("signals").getJob(`${ws}.evaluate.2026-11-03.run-3.1`);
    expect(job?.attemptsMade).toBe(2);
  });

  it("a job built for workspace A cannot read or write workspace B (scoped by payload)", async () => {
    const b = (await createTestAdmin("PipelineOther")).actor.workspaceId;
    const bId = await account(b, "B's account", 5);
    await getQueue("signals").add(
      "signals.evaluateChunk",
      { workspaceId: ws, asOf: "2026-11-02", runId: "forged", chunk: 0, accountIds: [bId] },
      { jobId: `${ws}.evaluate.2026-11-02.forged.0` },
    );
    await waitIdle();
    const bDb = scopedDb({ workspaceId: b });
    expect(await bDb.signal.count()).toBe(0);
    expect(await bDb.healthScoreSnapshot.count()).toBe(0);
    const [{ n }] = await rawDb.$queryRaw<[{ n: bigint }]>`SELECT count(*) AS n FROM "Signal"`;
    expect(Number(n)).toBe(0); // the raw client without a workspace setting sees nothing at all
  });

  it("chunk queries do not grow with the number of accounts (no N+1)", async () => {
    const run = (accountIds: string[]) =>
      countQueries(async () => {
        const data = { workspaceId: ws, asOf: "2026-11-02", runId: "budget", chunk: 0, accountIds };
        await processors.signals["signals.evaluateChunk"]!({
          data,
          name: "signals.evaluateChunk",
        } as Job);
        await processors.health["health.scoreChunk"]!({ data, name: "health.scoreChunk" } as Job);
        // Prisma emits query events asynchronously after each query resolves: let this run's
        // last parallel reads arrive inside its own count, not in the next run's.
        await new Promise((r) => setTimeout(r, 50));
      });
    // The background workers are paused (waiting for any active job) so they cannot add queries.
    await Promise.all(workers.map((w) => w.pause()));
    await run(ids); // settle
    const two = await run(ids.slice(0, 2));
    const five = await run(ids);
    workers.forEach((w) => w.resume());
    expect(five.queries).toBe(two.queries);
    // Measured constant (unchanged re-run of one chunk, any size): the point-in-time bundle is
    // loaded twice (signals, then health: ~18 set-based reads each), cohort peers three times
    // (baselines, signals, health: 4 each), workspace/settings lookups, rules, existing signals and
    // snapshots, one baseline insert, (M6) one read for open onboarding plans, and (M7) three for
    // renewals.sync (contracts, renewal rows, settings). Fixed per chunk; it must never scale with
    // accounts.
    expect(five.queries).toBeLessThanOrEqual(71);
  });

  it("the real-time hook evaluates one account through the queue at once", async () => {
    const db = scopedDb({ workspaceId: ws });
    await db.invoice.create({
      data: {
        workspaceId: ws,
        accountId: ids[2]!,
        number: "RT-1",
        amountMinor: 100n,
        issuedAt: utcMidnight("2026-10-01"),
        dueAt: utcMidnight("2026-10-31"),
        lastFailedAt: new Date("2026-11-01T10:00:00Z"),
        failureCount: 1,
        status: "FAILED",
      },
    });
    await enqueueAccountEvaluation({ workspaceId: ws }, [ids[2]!], "invoice.failed", deps.clock);
    await waitIdle();
    expect(
      await db.signal.count({
        where: { accountId: ids[2]!, ruleKey: "payment_failed", status: "OPEN" },
      }),
    ).toBe(1);
  });
});

describe("the workspace's own today (M3 rule 7)", () => {
  it("kickoff dates the run in each workspace's time zone, so calendar windows fire on the right day", async () => {
    const out: Record<string, { asOf: string; renewal90: number }> = {};
    for (const tz of ["UTC", "Asia/Kolkata", "America/New_York"]) {
      const w = (await createTestAdmin(`Tz${tz.replace(/\W/g, "")}`)).actor.workspaceId;
      await rawDb.workspace.update({ where: { id: w }, data: { timezone: tz } });
      // Feb 1, 2027 is 91 days after Nov 2 and 90 days after Nov 3.
      await account(w, "Renews", 40, { renewal: "2027-02-01" });
      await nightly(w, "tz"); // no asOf: today is computed from the clock in the workspace's zone
      const s = await scopedDb({ workspaceId: w }).healthScoreSnapshot.findFirstOrThrow();
      out[tz] = {
        asOf: s.asOf.toISOString().slice(0, 10),
        renewal90: await scopedDb({ workspaceId: w }).signal.count({
          where: { ruleKey: "renewal_window_90" },
        }),
      };
    }
    expect(out).toEqual({
      UTC: { asOf: "2026-11-02", renewal90: 0 },
      "Asia/Kolkata": { asOf: "2026-11-03", renewal90: 1 },
      "America/New_York": { asOf: "2026-11-02", renewal90: 0 },
    });
  });
});
