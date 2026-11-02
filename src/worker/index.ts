/**
 * Background worker process (DECISIONS D-02): `pnpm dev:worker` in development, started next to
 * the web app by `pnpm dev`. Shares src/modules and src/lib with the web app.
 */
import { Worker } from "bullmq";
import {
  getQueue,
  QUEUE_NAMES,
  queuePrefix,
  redisConnection,
  closeQueues,
} from "@/lib/jobs/queues";
import { logger } from "@/lib/logger";
import { processorFor, SCHEDULES } from "./processors";

process.env.NEXAWORKS_PROCESS ??= "worker";

async function main(): Promise<void> {
  const workers = QUEUE_NAMES.flatMap((name) => {
    const processor = processorFor(name);
    if (!processor) return [];
    const worker = new Worker(name, processor, {
      connection: redisConnection(),
      prefix: queuePrefix(),
      concurrency: 4,
    });
    worker.on("failed", (job, err) =>
      logger.error({ queue: name, job: job?.name, jobId: job?.id, err: err.message }, "job failed"),
    );
    return [worker];
  });

  for (const s of SCHEDULES) {
    await getQueue(s.queue).upsertJobScheduler(s.id, { every: s.everyMs }, { name: s.job });
  }
  logger.info({ queues: workers.map((w) => w.name) }, "worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker stopping");
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
