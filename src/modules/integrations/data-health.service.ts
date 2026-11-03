import type { Job, Queue } from "bullmq";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { getQueue, QUEUE_NAMES, type QueueName } from "@/lib/jobs/queues";
import type { Actor } from "@/modules/accounts/service";
import { PROVIDER_NAMES } from "./providers";

/**
 * Settings › Data health (ARCHITECTURE §1.2 "dead letter"): what did not work, in plain words.
 * Background jobs that failed after all their tries (this workspace's only: every tenant job
 * carries its workspaceId and nothing else is shown), syncs that failed, and webhook events that
 * could not be processed. Raw error messages are never shown: they are for engineers, and they can
 * name internals. A dead job can be run again by an Admin or CS Leader; that is audited.
 */
const JOB_LABELS: Record<string, string> = {
  "nightly.kickoff": "The nightly health and signals run",
  "signals.evaluateChunk": "Checking signals for a group of accounts",
  "health.scoreChunk": "Scoring health for a group of accounts",
  "health.backtest": "The health model back-test",
  "import.run": "A CSV import",
  "sync.run": "An integration sync",
  "webhook.process": "Processing a webhook event",
  "agents.run": "An AI agent run",
  "health-analyst.consider": "Writing a health narrative",
  "slack.approvalRequested": "Sending an approval to Slack",
};

export interface DeadJob {
  queue: QueueName;
  jobId: string;
  label: string;
  failedAt: Date | null;
  attempts: number;
}

type FailedSource = (queue: QueueName) => Pick<Queue, "getFailed" | "getJob">;

const isDead = (j: Job) => j.attemptsMade >= (j.opts.attempts ?? 1);

async function deadJobsFor(
  workspaceId: string,
  source: FailedSource,
): Promise<Array<DeadJob & { job: Job }>> {
  const out: Array<DeadJob & { job: Job }> = [];
  for (const queue of QUEUE_NAMES) {
    const failed = await source(queue).getFailed(0, 499);
    for (const job of failed) {
      if (!job || job.data?.workspaceId !== workspaceId || !isDead(job)) continue;
      out.push({
        queue,
        jobId: String(job.id),
        label: JOB_LABELS[job.name] ?? "A background job",
        failedAt: job.finishedOn ? new Date(job.finishedOn) : null,
        attempts: job.attemptsMade,
        job,
      });
    }
  }
  return out.sort((a, b) => (b.failedAt?.getTime() ?? 0) - (a.failedAt?.getTime() ?? 0));
}

const DAYS = 30;

export async function getDataHealth(
  actor: Actor,
  deps: { queues?: FailedSource; now?: Date } = {},
) {
  requirePermission(actor, "data:import");
  const db = scopedDb(actor);
  const since = new Date((deps.now ?? new Date()).getTime() - DAYS * 86_400_000);
  const [jobs, syncs, hooks] = await Promise.all([
    deadJobsFor(actor.workspaceId, deps.queues ?? getQueue),
    db.syncJob.findMany({
      where: { status: "FAILED", startedAt: { gte: since } },
      include: { integration: { select: { provider: true } } },
      orderBy: { startedAt: "desc" },
      take: 50,
    }),
    db.webhookEvent.findMany({
      where: { status: "FAILED", receivedAt: { gte: since } },
      include: { integration: { select: { provider: true } } },
      orderBy: { receivedAt: "desc" },
      take: 50,
    }),
  ]);
  return {
    jobs: jobs.map(({ job: _job, ...rest }) => rest),
    syncs: syncs.map((s) => ({
      id: s.id,
      provider: PROVIDER_NAMES[s.integration.provider],
      startedAt: s.startedAt,
      errorPlain: s.errorPlain ?? "The sync failed.",
    })),
    webhooks: webhookRows(hooks),
  };
}

function webhookRows(
  rows: Array<{
    id: string;
    eventType: string;
    receivedAt: Date;
    errorPlain: string | null;
    integration: { provider: keyof typeof PROVIDER_NAMES };
  }>,
) {
  return rows.map((h) => ({
    id: h.id,
    provider: PROVIDER_NAMES[h.integration.provider],
    eventType: h.eventType,
    receivedAt: h.receivedAt,
    errorPlain: h.errorPlain ?? "This event could not be processed.",
  }));
}

export class DataHealthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataHealthError";
  }
}

const retryInput = z.object({ queue: z.enum(QUEUE_NAMES), jobId: z.string().min(1).max(200) });

/** Runs a dead job again. Only this workspace's own dead jobs; audited. */
export async function retryDeadJob(
  actor: Actor,
  raw: unknown,
  deps: { queues?: FailedSource } = {},
) {
  requirePermission(actor, "data:import");
  const { queue, jobId } = retryInput.parse(raw);
  const job = await (deps.queues ?? getQueue)(queue).getJob(jobId);
  if (!job || job.data?.workspaceId !== actor.workspaceId || !isDead(job))
    throw new DataHealthError("That job is not in this workspace's failed list.");
  await job.retry("failed");
  await writeAudit({
    workspaceId: actor.workspaceId,
    actorType: "USER",
    actorId: actor.userId,
    action: "data_health.retried",
    targetType: "Job",
    targetId: `${queue}:${jobId}`,
    summary: `Ran again: ${JOB_LABELS[job.name] ?? "a background job"}`,
  });
}
