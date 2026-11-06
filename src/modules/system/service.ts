import type { Job, JobSchedulerJson, Queue } from "bullmq";
import { z } from "zod";
import { writeAudit, type AuditEntry } from "@/lib/audit";
import { requirePermission, type MemberAccess } from "@/lib/auth/permissions";
import { getQueue, QUEUE_NAMES } from "@/lib/jobs/queues";
import { scrubForLog } from "@/lib/logger";

/**
 * Settings › System › Jobs (M12 B4). Built on the BullMQ Queue API. Job data can hold workspace
 * ids and record content, so (Rule 2, Rule 8): an Admin sees only jobs whose data.workspaceId is
 * their own workspace, plus global sweeps (no workspaceId) as name/state/timestamps only. Job
 * data and stack traces are never returned; a failure reason (first line, scrubbed) is shown only
 * for the Admin's own jobs.
 */
export const JOB_STATES = ["waiting", "active", "delayed", "failed", "completed"] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Newest jobs examined per state. Counts are for what was examined; `truncated` says when more exist. */
export const SCAN_LIMIT = 200;
const FAILED_SHOWN = 10;

export type JobScope = "own" | "other" | "global";

export function classifyJob(data: unknown, workspaceId: string): JobScope {
  const id =
    data !== null && typeof data === "object"
      ? (data as { workspaceId?: unknown }).workspaceId
      : undefined;
  if (typeof id !== "string" || id === "") return "global";
  return id === workspaceId ? "own" : "other";
}

/** The slice of a BullMQ Job this module reads. */
export type JobLike = Pick<
  Job,
  | "id"
  | "name"
  | "data"
  | "attemptsMade"
  | "timestamp"
  | "finishedOn"
  | "failedReason"
  | "stacktrace"
> & {
  getState: () => Promise<string>;
  retry: () => Promise<unknown>;
};
export interface QueueLike {
  name: string;
  getJobs: (types: JobState[], start: number, end: number) => Promise<JobLike[]>;
  getJobSchedulers: () => Promise<
    Array<Pick<JobSchedulerJson, "key" | "name" | "pattern" | "every" | "next" | "tz" | "template">>
  >;
  getJob: (id: string) => Promise<JobLike | undefined>;
}

const asQueueLike = (q: Queue): QueueLike => q as unknown as QueueLike;
const defaultQueues = (): QueueLike[] => QUEUE_NAMES.map((n) => asQueueLike(getQueue(n)));

export interface FailedJobRow {
  id: string;
  name: string;
  scope: "workspace" | "global";
  attempts: number;
  at: string | null;
  /** First line of the failure, scrubbed. Own-workspace jobs only. */
  failedReason?: string;
}
export interface ScheduleRow {
  key: string;
  name: string;
  every: string;
  next: string | null;
}
export interface QueueOverview {
  name: string;
  counts: Record<JobState, number>;
  truncated: boolean;
  schedules: ScheduleRow[];
  recentFailed: FailedJobRow[];
}

// A key ending in an id-shaped suffix (cuid or uuid) belongs to some workspace: hidden unless ours.
const WORKSPACE_SUFFIX = /-(?:[A-Za-z0-9_]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{18,})$/;

/** A schedule is shown when it is this workspace's, or global (no workspace id in key or data). */
function scheduleVisible(
  s: Pick<JobSchedulerJson, "key" | "template">,
  workspaceId: string,
): boolean {
  const scope = classifyJob(s.template?.data, workspaceId);
  if (scope !== "global") return scope === "own";
  if (s.key.endsWith(`-${workspaceId}`)) return true;
  return !WORKSPACE_SUFFIX.test(s.key);
}

const iso = (ms: number | undefined | null) => (ms ? new Date(ms).toISOString() : null);

function describeEvery(s: Pick<JobSchedulerJson, "pattern" | "every" | "tz">): string {
  if (s.pattern) return s.tz ? `cron ${s.pattern} (${s.tz})` : `cron ${s.pattern}`;
  if (s.every)
    return s.every % 60_000 === 0 ? `every ${s.every / 60_000} min` : `every ${s.every / 1000} s`;
  return "irregular";
}

const firstLine = (reason: string | undefined): string => {
  const line =
    String(scrubForLog(reason ?? ""))
      .split("\n")[0]
      ?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
};

async function overviewOf(q: QueueLike, workspaceId: string): Promise<QueueOverview> {
  const counts = Object.fromEntries(JOB_STATES.map((s) => [s, 0])) as Record<JobState, number>;
  let truncated = false;
  let failed: JobLike[] = [];
  for (const state of JOB_STATES) {
    const jobs = await q.getJobs([state], 0, SCAN_LIMIT - 1);
    if (jobs.length >= SCAN_LIMIT) truncated = true;
    const visible = jobs.filter((j) => classifyJob(j.data, workspaceId) !== "other");
    counts[state] = visible.length;
    if (state === "failed") failed = visible;
  }
  const recentFailed = failed
    .sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0))
    .slice(0, FAILED_SHOWN)
    .map((j): FailedJobRow => {
      const own = classifyJob(j.data, workspaceId) === "own";
      return {
        id: String(j.id ?? ""),
        name: j.name,
        scope: own ? "workspace" : "global",
        attempts: j.attemptsMade,
        at: iso(j.finishedOn ?? j.timestamp),
        ...(own ? { failedReason: firstLine(j.failedReason) } : {}),
      };
    });
  const schedules = (await q.getJobSchedulers())
    .filter((s) => scheduleVisible(s, workspaceId))
    .map((s) => ({ key: s.key, name: s.name, every: describeEvery(s), next: iso(s.next) }));
  return { name: q.name, counts, truncated, schedules, recentFailed };
}

type Actor = MemberAccess & { workspaceId: string; userId: string };

/** Admin-only (workspace:manageSettings). One overview per queue, scoped to the actor's workspace. */
export async function jobsOverview(
  actor: Actor,
  queues: QueueLike[] = defaultQueues(),
): Promise<{ queues: QueueOverview[] }> {
  requirePermission(actor, "workspace:manageSettings");
  return { queues: await Promise.all(queues.map((q) => overviewOf(q, actor.workspaceId))) };
}

export const retryInput = z.object({
  queue: z.enum(QUEUE_NAMES),
  jobId: z.string().min(1).max(200),
});

/** Retries one failed job of the actor's own workspace; false (and no change) for anything else. */
export async function retryJob(
  actor: Actor,
  raw: unknown,
  deps: { queues?: QueueLike[]; audit?: (e: AuditEntry) => Promise<unknown> } = {},
): Promise<boolean> {
  requirePermission(actor, "workspace:manageSettings");
  const input = retryInput.parse(raw);
  const q = (deps.queues ?? defaultQueues()).find((x) => x.name === input.queue);
  const job = await q?.getJob(input.jobId);
  if (!job || classifyJob(job.data, actor.workspaceId) !== "own") return false;
  if ((await job.getState()) !== "failed") return false;
  await job.retry();
  await (deps.audit ?? writeAudit)({
    workspaceId: actor.workspaceId,
    actorType: "USER",
    actorId: actor.userId,
    action: "job.retried",
    targetType: "Job",
    targetId: `${input.queue}:${input.jobId}`,
    summary: `Retried failed job ${job.name} in the ${input.queue} queue`,
  });
  return true;
}
