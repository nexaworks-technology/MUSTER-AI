import { syncPromises } from "@/modules/promises/service";
import type { Job } from "bullmq";
import { z } from "zod";
import { businessClock, todayIn, type Clock } from "@/lib/dates";
import { backtestJobId, manualRunId, realtimeRunId } from "@/lib/jobs/ids";
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
import { addNightlySyncFlow } from "@/modules/integrations/service";
import { evaluateOnboarding } from "@/modules/onboarding/service";
import { syncArrChecks } from "@/modules/revenue/service";
import { evaluateAndStore } from "./lifecycle";
import { parseParams } from "./rules/catalog";

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
  /** Set on the flow parent that runs once the integration syncs finished (M5). */
  afterSync: z.boolean().optional(),
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
  // M5 (ARCHITECTURE §1.2 step 2): with connected data integrations, sync first. The fan-out
  // below then runs in the flow parent, after every sync.run child has finished.
  if (!data.afterSync) {
    const syncs = await addNightlySyncFlow(ctx, { asOf, runId: run });
    if (syncs > 0) return { asOf, runId: run, waitingOnSyncs: syncs };
  }
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

/** Evaluate stage of one chunk (shared by the queue job and the seed's inline run). */
async function evaluateCore(data: ChunkData, clock: Clock) {
  const ctx = { workspaceId: data.workspaceId };
  // M9 `promises.sync`: promises and AI-read goals from the latest extractions, statuses recomputed
  // by code for this business date, so the promise rules below read current records.
  await syncPromises(ctx, { today: data.asOf, accountIds: data.accountIds });
  await storeUsageBaselines(ctx, data.asOf, data.accountIds);
  // M6 `onboarding.evaluate`: step completions, value reached and stall status, then the signal
  // rules read the same facts (D4). Its thresholds are the onboarding_stall rule's settings.
  const onboarding = await evaluateOnboarding(ctx, data.accountIds, data.asOf, async () => {
    const row = await scopedDb(ctx).signalRule.findUnique({
      where: { workspaceId_ruleKey: { workspaceId: ctx.workspaceId, ruleKey: "onboarding_stall" } },
      select: { params: true },
    });
    return parseParams("onboarding_stall", row?.params);
  });
  return evaluateAndStore(ctx, data.accountIds, data.asOf, clock, onboarding.facts);
}

export async function evaluateChunk(raw: unknown, deps: PipelineDeps) {
  const data = chunkPayload.parse(raw);
  await deps.beforeStage?.("evaluate", data);
  const signals = await evaluateCore(data, deps.clock);
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
  return scoreCore(data);
}

/** Score stage of one chunk (shared by the queue job and the seed's inline run). */
async function scoreCore(data: ChunkData) {
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
  // M7 `renewals.sync`: confidence for renewals in the next year, and outcomes from contract
  // records, after tonight's snapshots exist. Loaded on use: the renewals back-test reads the
  // signals module.
  const { syncRenewals } = await import("@/modules/renewals/service");
  await syncRenewals(ctx, data.accountIds, data.asOf);
  // M7 B2 `expansion.sync`: one opportunity per account with a live expansion signal.
  const { syncExpansion } = await import("@/modules/expansion/service");
  await syncExpansion(ctx, data.accountIds, data.asOf);
  // D9: revenue events against the contract in force; a disagreement is a data-quality item.
  await syncArrChecks(ctx, data.accountIds, data.asOf);
  // M10: nightly cadence detector for QBRs (>= 90 days).
  const { syncQbrDue } = await import("@/modules/qbr/cadence");
  await syncQbrDue(ctx, data.accountIds, data.asOf);
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
  clock: Clock = businessClock,
) {
  const asOf = todayIn((await loadContext(ctx)).timeZone, clock);
  // The asOf is a business date (clock); the run id is one enqueue event (real time + random).
  const run = realtimeRunId(reason);
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
export async function enqueueWorkspaceRun(ctx: TenantContext) {
  // One request = one job, even in one instant (never the business clock; see lib/jobs/ids).
  const run = manualRunId();
  await add(
    "signals",
    "nightly.kickoff",
    { workspaceId: ctx.workspaceId, runId: run },
    `${ctx.workspaceId}.kickoff.${run}`,
  );
  return { runId: run };
}

/** Queue a back-test + proposal run for the workspace. */
export async function enqueueBacktest(ctx: TenantContext) {
  const id = backtestJobId(ctx.workspaceId);
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

/**
 * The same nightly stages run inline, chunk by chunk, for the seed (which has no worker). The
 * queue path (kickoff → evaluate → score jobs) is what runs every night and what the pipeline
 * test proves; this only skips the hand-off between processes.
 */
export async function runNightlyInline(ctx: TenantContext, asOf: string, clock: Clock) {
  const accounts = await scopedDb(ctx).account.findMany({
    where: { lifecycleStage: { not: "LOST" }, archivedAt: null },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const totals = {
    opened: 0,
    updated: 0,
    resolved: 0,
    suppressed: 0,
    CREATED: 0,
    REPLACED: 0,
    UNCHANGED: 0,
    bandChanges: 0,
  };
  for (let i = 0, chunk = 0; i < accounts.length; i += CHUNK_SIZE, chunk++) {
    const data: ChunkData = {
      workspaceId: ctx.workspaceId,
      asOf,
      runId: "seed",
      chunk,
      accountIds: accounts.slice(i, i + CHUNK_SIZE).map((a) => a.id),
    };
    const e = await evaluateCore(data, clock);
    const sc = await scoreCore(data);
    for (const [k, v] of Object.entries({ ...e, ...sc })) totals[k as keyof typeof totals] += v;
  }
  return totals;
}
