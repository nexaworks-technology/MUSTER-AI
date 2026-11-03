import type { Job } from "bullmq";
import { logger } from "@/lib/logger";
import { aggregateUsage } from "./aggregate";

/**
 * The `usage.aggregate` job's life in Redis (D-23, Q-33, D-110 as corrected by D-117). The events
 * a customer sent exist only in this job's payload, and only until they are folded into the daily
 * tables:
 *
 * - a completed job is removed at once (`removeOnComplete: true`); the ledger row (hash + counts)
 *   in `UsageIngestBatch` is the replay record, so a re-sent batch is still a no-op;
 * - a job that fails keeps its payload for its retries and nothing more: on the final attempt the
 *   events are scrubbed from the stored data (ids, batch key and an event count stay, enough to
 *   debug), and the failed record is kept one day, not thirty.
 */
export const USAGE_AGGREGATE_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: true,
  removeOnFail: { age: 86_400 },
} as const;

type UsageJob = Pick<Job, "data" | "attemptsMade" | "opts" | "updateData">;

/** What stays on a failed job: where it came from and how many events it held, never the events. */
export function scrubbedUsageData(data: unknown) {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const text = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : undefined);
  return {
    workspaceId: text("workspaceId"),
    integrationId: text("integrationId"),
    batchKey: text("batchKey"),
    events: [],
    scrubbedEvents: Array.isArray(d.events) ? d.events.length : 0,
  };
}

export async function processUsageAggregate(job: UsageJob) {
  try {
    return await aggregateUsage(job.data);
  } catch (err) {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (finalAttempt)
      await job.updateData(scrubbedUsageData(job.data)).catch((e: unknown) =>
        // Never hide the original failure behind a scrub failure; say it, without the payload.
        logger.warn(
          { err: e instanceof Error ? e.name : "unknown" },
          "usage job payload not scrubbed",
        ),
      );
    throw err;
  }
}
