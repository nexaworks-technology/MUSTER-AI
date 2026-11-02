import { QueueEvents, Worker } from "bullmq";
import { afterAll, describe, expect, it } from "vitest";
import { closeQueues, getQueue, queuePrefix, redisConnection } from "@/lib/jobs/queues";
import { processorFor } from "@/worker/processors";

/** Proves a job travels Redis → worker → result with the real BullMQ setup (test key prefix). */
describe("worker", () => {
  const worker = new Worker("maintenance", processorFor("maintenance")!, {
    connection: redisConnection(),
    prefix: queuePrefix(),
  });
  const events = new QueueEvents("maintenance", {
    connection: redisConnection(),
    prefix: queuePrefix(),
  });

  afterAll(async () => {
    await worker.close();
    await events.close();
    await closeQueues();
  });

  it("uses an isolated key prefix in tests", () => {
    expect(queuePrefix()).toBe("nexaworks-test");
  });

  it("processes a heartbeat job", async () => {
    await events.waitUntilReady();
    const job = await getQueue("maintenance").add("heartbeat", {});
    const result = (await job.waitUntilFinished(events, 15_000)) as { at: string };
    expect(new Date(result.at).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("fails an unknown job visibly instead of dropping it", async () => {
    const job = await getQueue("maintenance").add("no.such.job", {}, { attempts: 1 });
    await expect(job.waitUntilFinished(events, 15_000)).rejects.toThrow(
      /No handler for maintenance\/no.such.job/,
    );
  });
});
