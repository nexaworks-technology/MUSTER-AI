import type { Job } from "bullmq";
import { dispatchOutbox, OUTBOX_ROUTES } from "@/lib/jobs/outbox";
import type { QueueName } from "@/lib/jobs/queues";
import { logger } from "@/lib/logger";
import { importJobPayload, runImportJob } from "@/modules/imports/service";

/**
 * Job handlers by queue and job name. Tenant handlers (added from M2/M3 on) must parse their
 * payload with Zod and use scopedDb({ workspaceId: payload.workspaceId }).
 */
export type Processor = (job: Job) => Promise<unknown>;

export const PROCESSORS: Partial<Record<QueueName, Record<string, Processor>>> = {
  sync: {
    /** CSV import run (M2, D-47); re-scoped by the payload's workspaceId. */
    async "import.run"(job) {
      const { workspaceId, importJobId } = importJobPayload.parse(job.data);
      await runImportJob(workspaceId, importJobId);
      return { importJobId };
    },
  },
  maintenance: {
    async heartbeat(job) {
      const at = new Date().toISOString();
      logger.info({ jobId: job.id, at }, "worker heartbeat");
      return { at };
    },
    async "outbox.dispatch"() {
      return dispatchOutbox(OUTBOX_ROUTES);
    },
  },
};

/** Repeating maintenance jobs, registered idempotently at worker start. */
export const SCHEDULES = [
  { queue: "maintenance", id: "heartbeat", job: "heartbeat", everyMs: 60_000 },
  { queue: "maintenance", id: "outbox-dispatch", job: "outbox.dispatch", everyMs: 5_000 },
] as const;

export function processorFor(queue: QueueName): Processor | undefined {
  const handlers = PROCESSORS[queue];
  if (!handlers) return undefined;
  return async (job) => {
    const handler = handlers[job.name];
    // An unknown job fails visibly (dead-letter after retries) instead of being dropped.
    if (!handler) throw new Error(`No handler for ${queue}/${job.name}`);
    return handler(job);
  };
}
