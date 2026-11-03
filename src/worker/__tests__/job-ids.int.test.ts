import { randomUUID } from "node:crypto";
import { Worker, type Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { getQueue, closeQueues, queuePrefix, redisConnection } from "@/lib/jobs/queues";
import { activateModel, DEFAULT_MODEL } from "@/modules/health/service";
import { enqueueWorkspaceRun } from "@/modules/signals/service";
import { createTestAdmin } from "@/test/fixtures";
import { PROCESSORS, processorFor } from "../processors";

/**
 * Job ids under the frozen business clock (Q-49 round 4, D-81):
 *  - the regression for the v43 failure: two model activations back-to-back in one frozen instant
 *    both complete their re-scores (each queued kickoff is its own job);
 *  - dedupe-intended ids still collapse a repeat enqueue of the same unit into one job.
 */
const saved = { allow: process.env.ALLOW_FAKE_CLOCK, now: process.env.APP_FAKE_NOW };
let workers: Worker[] = [];

beforeAll(() => {
  process.env.ALLOW_FAKE_CLOCK = "true";
  process.env.APP_FAKE_NOW = "2026-11-02T17:00:00Z";
  workers = (["signals", "health"] as const).map(
    (q) =>
      new Worker(q, processorFor(q)!, {
        connection: redisConnection(),
        prefix: queuePrefix(),
        concurrency: 2,
      }),
  );
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  if (saved.allow === undefined) delete process.env.ALLOW_FAKE_CLOCK;
  else process.env.ALLOW_FAKE_CLOCK = saved.allow;
  if (saved.now === undefined) delete process.env.APP_FAKE_NOW;
  else process.env.APP_FAKE_NOW = saved.now;
  await closeQueues();
});

async function until<T>(read: () => Promise<T | null | undefined>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("job ids under a frozen business clock", () => {
  it("two model activations back-to-back both complete their re-scores", async () => {
    const { actor } = await createTestAdmin("ActivationIds");
    const db = scopedDb(actor);
    const ws = actor.workspaceId;
    const account = await db.account.create({
      data: { workspaceId: ws, name: "Rescored", tier: "MID_TOUCH" },
    });
    const draft = (version: number) =>
      db.healthModel.create({
        data: {
          workspaceId: ws,
          version,
          status: "DRAFT",
          proposedBy: "HUMAN",
          pillarWeights: DEFAULT_MODEL.pillarWeights,
          componentConfig: DEFAULT_MODEL.componentConfig as object,
          thresholds: DEFAULT_MODEL.thresholds,
        },
      });
    const [a, b] = [await draft(1), await draft(2)];
    const scored = (modelId: string) =>
      until(
        () =>
          db.healthScoreSnapshot.findFirst({
            where: { accountId: account.id, healthModelId: modelId, isBacktest: false },
          }),
        `a snapshot under model ${modelId}`,
      );

    // Exactly what activateModelAction does, twice, in one frozen instant.
    await activateModel(actor, a.id);
    const first = await enqueueWorkspaceRun(actor);
    const snapA = await scored(a.id);
    await activateModel(actor, b.id);
    const second = await enqueueWorkspaceRun(actor);
    const snapB = await scored(b.id);

    expect(second.runId).not.toBe(first.runId);
    expect(snapA.asOf.toISOString().slice(0, 10)).toBe("2026-11-02");
    expect(snapB.asOf.toISOString().slice(0, 10)).toBe("2026-11-02");
  }, 90_000);

  it("a dedupe-intended id still collapses a repeat enqueue of the same unit into one job", async () => {
    const { actor } = await createTestAdmin("DedupeIds");
    const ws = actor.workspaceId;
    await scopedDb(actor).account.create({
      data: { workspaceId: ws, name: "Dup", tier: "MID_TOUCH" },
    });
    const kickoff = PROCESSORS.signals!["nightly.kickoff"]!;
    const run = `dedupe-${randomUUID().slice(0, 8)}`;
    const job = {
      name: "nightly.kickoff",
      data: { workspaceId: ws, runId: run, asOf: "2026-11-02" },
    } as Job;
    // Pause the workers' interest: enqueue the same chunk unit twice and count the resulting jobs.
    await Promise.all(workers.map((w) => w.pause()));
    await kickoff(job);
    await kickoff(job);
    const id = `${ws}.evaluate.2026-11-02.${run}.0`;
    const jobs = await getQueue("signals").getJobs(
      ["waiting", "delayed", "active", "completed", "failed"],
      0,
      5_000,
    );
    expect(jobs.filter((j) => j?.id === id)).toHaveLength(1);
    workers.forEach((w) => w.resume());
  }, 60_000);
});
