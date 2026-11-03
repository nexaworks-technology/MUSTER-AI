import { randomUUID } from "node:crypto";
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "@/lib/config/env";
import { fixedClock } from "@/lib/dates";
import { closeQueues, getQueue, queuePrefix, redisConnection } from "@/lib/jobs/queues";
import { scopedDb } from "@/lib/db/scoped";
import {
  issueUsageApiKey,
  processUsageAggregate,
  receiveUsage,
  scrubbedUsageData,
  USAGE_AGGREGATE_JOB_OPTIONS,
} from "@/modules/integrations/service";
import { createTestAdmin } from "@/test/fixtures";

/**
 * D-117 (review S1): raw usage events do not outlive aggregation in Redis. A completed
 * `usage.aggregate` job is removed (the ledger is the replay record, so a replayed batch still
 * changes nothing); a failed one keeps its payload for its retries, then the events are scrubbed
 * and the record is kept one day. Real queue, real worker, real Redis.
 */
vi.hoisted(() => {
  process.env.QUEUE_PREFIX = "nexaworks-usage-retention-test";
});

const NOON = fixedClock("2026-11-02T12:00:00Z");
const EMAIL = "someone.private@customer-retention.test";
let worker: Worker;
let redis: Redis;
let completed = 0;
const attemptsSeen: number[] = [];
const failed: Job[] = [];

beforeAll(async () => {
  redis = new Redis(env().REDIS_URL);
  // This file owns its queue prefix: start from an empty one (a failed earlier run leaves keys).
  const stale = await redis.keys(`${queuePrefix()}:*`);
  if (stale.length) await redis.del(...stale);
  const { PROCESSORS } = await import("@/worker/processors");
  worker = new Worker(
    "sync",
    async (job: Job) => {
      if (job.name !== "usage.aggregate") return undefined;
      attemptsSeen.push(Array.isArray(job.data.events) ? job.data.events.length : -1);
      return PROCESSORS.sync!["usage.aggregate"]!(job);
    },
    { connection: redisConnection(), prefix: queuePrefix() },
  );
  worker.on("completed", () => void completed++);
  worker.on("failed", (job) => job && failed.push(job));
  await worker.waitUntilReady();
});
afterAll(async () => {
  await worker.close();
  await closeQueues();
  await redis.quit();
});

const until = async (what: string, check: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const usageKeys = () => redis.keys(`${queuePrefix()}:sync:usage-*`);

describe("usage.aggregate job retention", () => {
  it("declares removal on completion and a one-day failed record", () => {
    expect(USAGE_AGGREGATE_JOB_OPTIONS).toMatchObject({
      removeOnComplete: true,
      removeOnFail: { age: 86_400 },
    });
  });

  it("a completed job's payload is gone from Redis; a replayed batch still changes nothing", async () => {
    const { actor } = await createTestAdmin("Retention");
    const db = scopedDb(actor);
    const account = await db.account.create({
      data: { workspaceId: actor.workspaceId, name: "Retention Co", tier: "MID_TOUCH" },
    });
    const { key } = await issueUsageApiKey(actor);
    const post = () =>
      receiveUsage(
        "batch",
        {
          headers: { authorization: `Bearer ${key}` },
          url: "http://localhost/api/usage/v1/batch",
          rawBody: JSON.stringify({
            batch: [
              {
                type: "track",
                userId: EMAIL,
                groupId: account.id,
                event: "Opened",
                messageId: "ret-1",
              },
              {
                type: "track",
                userId: EMAIL,
                groupId: account.id,
                event: "Opened",
                messageId: "ret-2",
              },
            ],
          }),
        },
        { clock: NOON, now: () => new Date("2026-11-02T12:00:00Z") },
      );
    const before = completed;
    expect((await post()).status).toBe(202);
    await until("the first aggregation", () => completed === before + 1);
    await until("the job to leave Redis", async () => (await usageKeys()).length === 0);
    // Nothing of the events remains anywhere under this queue's prefix.
    const everything = await redis.keys(`${queuePrefix()}:*`);
    for (const k of everything) {
      const type = await redis.type(k);
      const dump = type === "hash" ? JSON.stringify(await redis.hgetall(k)) : "";
      expect(dump).not.toContain(EMAIL);
    }
    const snapshot = async () =>
      JSON.stringify([
        await db.usageDaily.findMany(),
        await db.userUsageDaily.findMany(),
        await db.usageIngestBatch.findMany(),
      ]);
    const afterFirst = await snapshot();
    expect(await db.usageIngestBatch.count()).toBe(1);

    expect((await post()).status).toBe(202);
    await until("the replay to be processed", () => completed === before + 2);
    await until("the replayed job to leave Redis", async () => (await usageKeys()).length === 0);
    expect(await snapshot()).toBe(afterFirst);
  });

  it("a failing job keeps its events for its retries, then they are scrubbed; ids and a count stay", async () => {
    attemptsSeen.length = 0;
    failed.length = 0;
    const jobId = `usage-bad-${randomUUID()}`;
    const events = Array.from({ length: 3 }, (_, i) => ({
      kind: "track",
      userId: EMAIL,
      groupRef: "g",
      at: "2026-11-02T12:00:00.000Z",
      messageId: `bad-${i}`,
      event: "Opened",
    }));
    // A bad batch key fails the payload check on every attempt.
    await getQueue("sync").add(
      "usage.aggregate",
      { workspaceId: "ws-x", integrationId: "int-x", batchKey: "not-a-hash", events },
      { ...USAGE_AGGREGATE_JOB_OPTIONS, attempts: 2, backoff: { type: "fixed", delay: 50 }, jobId },
    );
    await until("the final failure", () =>
      failed.some((j) => j.id === jobId && j.attemptsMade >= 2),
    );
    // Both attempts saw the whole payload: the scrub waits for the last one.
    expect(attemptsSeen).toEqual([3, 3]);
    await until("the scrub", async () => {
      const job = await getQueue("sync").getJob(jobId);
      return Boolean(job && job.data.scrubbedEvents === 3);
    });
    const job = (await getQueue("sync").getJob(jobId))!;
    expect(job.data).toEqual({
      workspaceId: "ws-x",
      integrationId: "int-x",
      batchKey: "not-a-hash",
      events: [],
      scrubbedEvents: 3,
    });
    expect(JSON.stringify(await redis.hgetall(`${queuePrefix()}:sync:${jobId}`))).not.toContain(
      EMAIL,
    );
    await job.remove();
  });
});

describe("the scrub helper and the final-attempt rule", () => {
  it("keeps only ids, the batch key and a count; tolerates a malformed payload", () => {
    expect(
      scrubbedUsageData({
        workspaceId: "w",
        integrationId: "i",
        batchKey: "b",
        events: [{ userId: EMAIL }, {}],
      }),
    ).toEqual({
      workspaceId: "w",
      integrationId: "i",
      batchKey: "b",
      events: [],
      scrubbedEvents: 2,
    });
    expect(scrubbedUsageData("garbage")).toEqual({
      workspaceId: undefined,
      integrationId: undefined,
      batchKey: undefined,
      events: [],
      scrubbedEvents: 0,
    });
  });

  it("scrubs on the last of 3 attempts only, and still throws the original error", async () => {
    const updateData = vi.fn(async () => undefined);
    const run = (attemptsMade: number) =>
      processUsageAggregate({
        data: { not: "a payload", events: [{}] },
        attemptsMade,
        opts: { attempts: 3 },
        updateData,
      } as never);
    await expect(run(0)).rejects.toThrow();
    await expect(run(1)).rejects.toThrow();
    expect(updateData).not.toHaveBeenCalled();
    await expect(run(2)).rejects.toThrow();
    expect(updateData).toHaveBeenCalledOnce();
  });
});
