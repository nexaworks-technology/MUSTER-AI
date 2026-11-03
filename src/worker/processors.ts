import type { Job } from "bullmq";
import { dispatchOutbox, OUTBOX_ROUTES } from "@/lib/jobs/outbox";
import type { QueueName } from "@/lib/jobs/queues";
import { logger } from "@/lib/logger";
import { systemClock } from "@/lib/dates";
import { listActiveWorkspaces } from "@/lib/db/workspace";
import { getQueue } from "@/lib/jobs/queues";
import { processAgentRun } from "@/modules/agents/service";
import { importJobPayload, runImportJob } from "@/modules/imports/service";
import { createPipelineProcessors } from "@/modules/signals/service";

const pipeline = createPipelineProcessors({ clock: systemClock });

/**
 * One repeatable nightly kickoff per active workspace, at 02:00 in that workspace's time zone
 * (ARCHITECTURE §1.2). Idempotent: re-registering updates the schedule in place.
 */
export async function syncNightlySchedules(): Promise<number> {
  const workspaces = await listActiveWorkspaces();
  for (const w of workspaces)
    await getQueue("signals").upsertJobScheduler(
      `nightly-${w.id}`,
      { pattern: "0 2 * * *", tz: w.timezone },
      { name: "nightly.kickoff", data: { workspaceId: w.id }, opts: { attempts: 3 } },
    );
  return workspaces.length;
}

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
  /** M3: the nightly run and the real-time hook (signals → health), scoped by payload. */
  signals: pipeline.signals,
  health: pipeline.health,
  /** M4: one agent run per job, scoped by the payload's workspaceId (ARCHITECTURE §1.3). */
  agents: {
    async "agents.run"(job) {
      return processAgentRun(job.data);
    },
  },
  maintenance: {
    async "nightly.schedules"() {
      return { workspaces: await syncNightlySchedules() };
    },
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
  // New workspaces get their nightly run within the hour (and at worker start, see index.ts).
  { queue: "maintenance", id: "nightly-schedules", job: "nightly.schedules", everyMs: 3_600_000 },
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
