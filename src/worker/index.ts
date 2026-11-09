/**
 * Background worker process (DECISIONS D-02): `pnpm dev:worker` in development, started next to
 * the web app by `pnpm dev`. Shares src/modules and src/lib with the web app.
 */
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import {
  getQueue,
  QUEUE_NAMES,
  queuePrefix,
  redisConnection,
  closeQueues,
} from "@/lib/jobs/queues";
import { env } from "@/lib/config/env";
import { jobLogger, logger, runWithJobContext, type JobContext } from "@/lib/logger";
import { captureError } from "@/lib/observability/error-tracking";
import { startHeartbeat } from "@/lib/observability/heartbeat";
import { processorFor, SCHEDULES, syncNightlySchedules } from "./processors";

process.env.NEXAWORKS_PROCESS ??= "worker";

const contextOf = (queue: string, job: Job): JobContext => ({
  jobId: String(job.id ?? ""),
  queue,
  job: job.name,
});

async function main(): Promise<void> {
  const heartbeatRedis = new Redis(env().REDIS_URL, { maxRetriesPerRequest: 1 });
  const stopHeartbeat = startHeartbeat(heartbeatRedis, (err) =>
    logger.warn({ err: err instanceof Error ? err.name : "unknown" }, "worker heartbeat failed"),
  );
  const workers = QUEUE_NAMES.flatMap((name) => {
    const processor = processorFor(name);
    if (!processor) return [];
    // Every line logged while a job runs carries jobId, queue and job (M12 B4).
    const worker = new Worker(
      name,
      (job: Job) => {
        const ctx = contextOf(name, job);
        return runWithJobContext(ctx, async () => {
          jobLogger(ctx).debug("job started");
          return processor(job);
        });
      },
      {
        connection: redisConnection(),
        prefix: queuePrefix(),
        concurrency: 4,
        // Longer lock duration for signals and health workers under heavy scale load (D-185, approved in Session C).
        ...(name === "signals" || name === "health" ? { lockDuration: 120_000 } : {}),
      },
    );
    worker.on("failed", (job, err) => {
      const ctx = job ? contextOf(name, job) : { jobId: "", queue: name, job: "unknown" };
      jobLogger(ctx).error({ err: err.message, attemptsMade: job?.attemptsMade }, "job failed");
      void captureError(err, ctx);
    });
    return [worker];
  });

  for (const s of SCHEDULES) {
    await getQueue(s.queue).upsertJobScheduler(s.id, { every: s.everyMs }, { name: s.job });
  }
  const scheduled = await syncNightlySchedules();
  logger.info(
    { queues: workers.map((w) => w.name), nightlyWorkspaces: scheduled },
    "worker started",
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker stopping");
    stopHeartbeat();
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    heartbeatRedis.disconnect();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
