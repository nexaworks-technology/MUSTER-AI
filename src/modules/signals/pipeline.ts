import type { Job } from "bullmq";
import { z } from "zod";
import { systemClock, todayIn, type Clock } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { writeOutboxEvent } from "@/lib/jobs/outbox";
import { getQueue, type QueueName } from "@/lib/jobs/queues";
import {
  getActiveModel,
  loadContext,
  runBacktestProposal,
  scoreAndStore,
  storeUsageBaselines,
} from "@/modules/health/service";
import { evaluateAndStore } from "./lifecycle";

/**
 * The nightly run (ARCHITECTURE §1.2, M3 rule 9), as queue jobs:
 *
 *   nightly.kickoff (signals queue, 02:00 workspace time) → one signals.evaluateChunk per 200
 *   active accounts → each enqueues health.scoreChunk for the same accounts.
 *
 * Every job is scoped by its payload's workspaceId (scopedDb), idempotent (upserts on unique keys)
 * and retried with backoff without blocking other chunks. Job ids are deterministic per run:
 * `<workspace>.<stage>.<asOf>.<runId>.<chunk>`. The real-time hook and "Recompute now" enqueue
 * the same chunk job.
 */
export const CHUNK_SIZE = 200;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const runId = z.string().regex(/^[\w-]{1,80}$/);

export const kickoffPayload = z.object({
  workspaceId: z.string().min(1),
  asOf: day.optional(),
  runId: runId.optional(),
});
export const chunkPayload = z.object({
  workspaceId: z.string().min(1),
  asOf: day,
  runId,
  chunk: z.number().int().min(0),
  accountIds: z.array(z.string().min(1)).max(1000),
});
export type ChunkData = z.infer<typeof chunkPayload>;

export interface PipelineDeps {
  clock: Clock;
  chunkSize?: number;
  /** Test hook: runs before a chunk stage (used to prove retries isolate a failing chunk). */
  beforeStage?: (stage: "evaluate" | "score", data: ChunkData) => void | Promise<void>;
}

const JOB_OPTS = { attempts: 3, backoff: { type: "exponential", delay: 1_000 } } as const;

function add(queue: QueueName, name: string, data: object, jobId: string) {
  return getQueue(queue).add(name, data, { jobId, ...JOB_OPTS });
}

export async function kickoff(raw: unknown, deps: PipelineDeps) {
  const data = kickoffPayload.parse(raw);
  const ctx = { workspaceId: data.workspaceId };
  const asOf = data.asOf ?? todayIn((await loadContext(ctx)).timeZone, deps.clock);
  const run = data.runId ?? `nightly-${asOf}`;
  const accounts = await scopedDb(ctx).account.findMany({
    where: { lifecycleStage: { not: "LOST" }, archivedAt: null },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const size = deps.chunkSize ?? CHUNK_SIZE;
  let chunk = 0;
  for (let i = 0; i < accounts.length; i += size, chunk++) {
    const payload: ChunkData = {
      workspaceId: ctx.workspaceId,
      asOf,
      runId: run,
      chunk,
      accountIds: accounts.slice(i, i + size).map((a) => a.id),
    };
    await add(
      "signals",
      "signals.evaluateChunk",
      payload,
      `${ctx.workspaceId}.evaluate.${asOf}.${run}.${chunk}`,
    );
  }
  return { asOf, runId: run, chunks: chunk, accounts: accounts.length };
}

export async function evaluateChunk(raw: unknown, deps: PipelineDeps) {
  const data = chunkPayload.parse(raw);
  await deps.beforeStage?.("evaluate", data);
  const ctx = { workspaceId: data.workspaceId };
  await storeUsageBaselines(ctx, data.asOf, data.accountIds);
  const signals = await evaluateAndStore(ctx, data.accountIds, data.asOf, deps.clock);
  await add(
    "health",
    "health.scoreChunk",
    data,
    `${data.workspaceId}.score.${data.asOf}.${data.runId}.${data.chunk}`,
  );
  return signals;
}

export async function scoreChunk(raw: unknown, deps: PipelineDeps) {
  const data = chunkPayload.parse(raw);
  await deps.beforeStage?.("score", data);
  const ctx = { workspaceId: data.workspaceId };
  const model = await getActiveModel(ctx);
  const results = await scoreAndStore(ctx, data.accountIds, data.asOf, model, {
    makeCurrent: true,
  });
  const changed = [...results].filter(
    ([, r]) => r.outcome !== "UNCHANGED" && r.previous !== null && r.previous !== r.score.riskLevel,
  );
  if (changed.length)
    await scopedDb(ctx).$tenantTransaction(async (tx) => {
      for (const [accountId, r] of changed)
        await writeOutboxEvent(tx, {
          workspaceId: data.workspaceId,
          type: "health.bandChanged",
          payload: {
            accountId,
            snapshotId: r.id,
            from: r.previous!,
            to: r.score.riskLevel,
            asOf: data.asOf,
          },
        });
    });
  const counts = { CREATED: 0, REPLACED: 0, UNCHANGED: 0 };
  for (const r of results.values()) counts[r.outcome]++;
  return { ...counts, bandChanges: changed.length };
}

type Processor = (job: Job) => Promise<unknown>;

export function createPipelineProcessors(deps: PipelineDeps): {
  signals: Record<string, Processor>;
  health: Record<string, Processor>;
} {
  return {
    signals: {
      "nightly.kickoff": (job) => kickoff(job.data, deps),
      "signals.evaluateChunk": (job) => evaluateChunk(job.data, deps),
    },
    health: {
      "health.scoreChunk": (job) => scoreChunk(job.data, deps),
      /** Back-test + proposal (seconds, not a page request): stores a DRAFT, never activates. */
      "health.backtest": async (job) => {
        const { workspaceId } = z.object({ workspaceId: z.string().min(1) }).parse(job.data);
        const draft = await runBacktestProposal({ workspaceId }, deps.clock);
        return { draftId: draft.id, version: draft.version };
      },
    },
  };
}

/**
 * Real-time hook (ARCHITECTURE §5.2): evaluate a few accounts now, through the same chunk job as
 * the nightly run (after a Pulse, a payment failure, an escalation, or "Recompute now").
 */
export async function enqueueAccountEvaluation(
  ctx: TenantContext,
  accountIds: string[],
  reason: string,
  clock: Clock = systemClock,
) {
  const asOf = todayIn((await loadContext(ctx)).timeZone, clock);
  const run = `rt-${reason.replace(/[^\w-]/g, "-").slice(0, 30)}-${clock().getTime()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload: ChunkData = {
    workspaceId: ctx.workspaceId,
    asOf,
    runId: run,
    chunk: 0,
    accountIds,
  };
  await add(
    "signals",
    "signals.evaluateChunk",
    payload,
    `${ctx.workspaceId}.evaluate.${asOf}.${run}.0`,
  );
  return { asOf, runId: run };
}

/** "Recompute now" for the whole workspace: a kickoff with its own run id. */
export async function enqueueWorkspaceRun(ctx: TenantContext, clock: Clock = systemClock) {
  const run = `manual-${clock().getTime()}`;
  await add(
    "signals",
    "nightly.kickoff",
    { workspaceId: ctx.workspaceId, runId: run },
    `${ctx.workspaceId}.kickoff.${run}`,
  );
  return { runId: run };
}

/** Queue a back-test + proposal run for the workspace. */
export async function enqueueBacktest(ctx: TenantContext, clock: Clock = systemClock) {
  const id = `${ctx.workspaceId}.backtest.${clock().getTime()}`;
  await getQueue("health").add(
    "health.backtest",
    { workspaceId: ctx.workspaceId },
    { jobId: id, attempts: 1 },
  );
  return { jobId: id };
}

/** Whether a back-test is queued or running for the workspace (for the Settings screen). */
export async function backtestRunning(ctx: TenantContext): Promise<boolean> {
  const jobs = await getQueue("health").getJobs(
    ["waiting", "active", "delayed", "prioritized"],
    0,
    200,
  );
  return jobs.some((j) => j?.name === "health.backtest" && j.data?.workspaceId === ctx.workspaceId);
}
