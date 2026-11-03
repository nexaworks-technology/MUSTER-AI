import { Prisma, type SyncJob } from "@prisma/client";
import { z } from "zod";
import { realClock } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { manualRunId } from "@/lib/jobs/ids";
import { writeOutboxEvent } from "@/lib/jobs/outbox";
import { getFlowProducer, getQueue } from "@/lib/jobs/queues";
import { logger } from "@/lib/logger";
import { adapterFor } from "./adapters";
import { loadConnection, type ConnectionDeps } from "./connection";
import { describeProviderError } from "./errors";
import { UnfixturedRequestError } from "./fixture-transport";
import {
  addCounts,
  emptyCounts,
  ingestBatch,
  type IngestCounts,
  type IngestProblem,
} from "./ingest.service";
import { PROVIDER_NAMES, recordSourceFor } from "./providers";
import { ProviderHttpError } from "./transport";

/**
 * The `sync.run` worker job (ARCHITECTURE §1.2 step 2, M5 §2). One SyncJob row per
 * (integration, runKey), so a re-enqueued nightly sync for the same run finds its SUCCEEDED row
 * and does nothing. INCREMENTAL resumes from the last SUCCEEDED run's cursor; a run that fails
 * part-way records `errorPlain` and keeps no cursor, so the next run starts from the last good one.
 * Provider errors end the job normally (recorded, shown in plain words): the nightly flow never
 * waits on a stuck sync. A test transport's missing fixture is rethrown, never swallowed.
 */
export const syncRunPayload = z.object({
  workspaceId: z.string().min(1),
  integrationId: z.string().min(1),
  kind: z.enum(["FULL", "INCREMENTAL"]),
  trigger: z.enum(["NIGHTLY", "MANUAL", "SETUP"]),
  runKey: z.string().regex(/^[\w.-]{1,100}$/),
});
export type SyncRunPayload = z.infer<typeof syncRunPayload>;

const PROBLEM_CAP = 50;
const ACCOUNT_ID_CAP = 1_000;
/** Data providers only: Slack writes no records, so it never runs a sync. */
const SYNCABLE = ["HUBSPOT", "SALESFORCE", "STRIPE", "CHARGEBEE"] as const;

export interface SyncOutcome {
  status: "SUCCEEDED" | "FAILED" | "SKIPPED";
  syncJobId?: string;
  counts?: IngestCounts;
  errorPlain?: string;
}

async function startJob(ctx: TenantContext, p: SyncRunPayload, cursorIn: string | null) {
  const db = scopedDb(ctx);
  const existing = await db.syncJob.findUnique({
    where: {
      workspaceId_integrationId_runKey: {
        workspaceId: ctx.workspaceId,
        integrationId: p.integrationId,
        runKey: p.runKey,
      },
    },
  });
  if (existing?.status === "SUCCEEDED") return { job: existing, done: true };
  const fresh = {
    kind: cursorIn ? ("INCREMENTAL" as const) : ("FULL" as const),
    status: "RUNNING" as const,
    cursorIn,
    cursor: null,
    startedAt: realClock(),
    finishedAt: null,
    errorPlain: null,
  };
  if (existing)
    return {
      job: await db.syncJob.update({ where: { id: existing.id }, data: fresh }),
      done: false,
    };
  try {
    const job = await db.syncJob.create({
      data: {
        workspaceId: ctx.workspaceId,
        integrationId: p.integrationId,
        trigger: p.trigger,
        runKey: p.runKey,
        ...fresh,
      },
    });
    return { job, done: false };
  } catch (e) {
    // Two workers raced on the same run: the other one owns it.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
      return { job: null, done: true };
    throw e;
  }
}

async function lastGoodCursor(ctx: TenantContext, integrationId: string): Promise<string | null> {
  const last = await scopedDb(ctx).syncJob.findFirst({
    where: { integrationId, status: "SUCCEEDED", cursor: { not: null } },
    orderBy: { finishedAt: "desc" },
    select: { cursor: true },
  });
  return last?.cursor ?? null;
}

export async function runSync(raw: unknown, deps: ConnectionDeps = {}): Promise<SyncOutcome> {
  const p = syncRunPayload.parse(raw);
  const ctx = { workspaceId: p.workspaceId };
  const db = scopedDb(ctx);
  const integration = await db.integration.findUnique({ where: { id: p.integrationId } });
  const source = integration ? recordSourceFor(integration.provider) : null;
  if (!integration || integration.status === "DISCONNECTED" || !source)
    return { status: "SKIPPED" };

  const cursorIn = p.kind === "INCREMENTAL" ? await lastGoodCursor(ctx, integration.id) : null;
  const started = await startJob(ctx, p, cursorIn);
  if (started.done || !started.job) return { status: "SKIPPED", syncJobId: started.job?.id };
  const job: SyncJob = started.job;

  let counts = emptyCounts();
  const problems: IngestProblem[] = [];
  const accountIds = new Set<string>();
  let cursor: string | null = cursorIn;
  const name = PROVIDER_NAMES[integration.provider];
  try {
    const { adapter, context } = await loadConnection(ctx, integration.id, deps);
    const pages = adapter.sync(context, {
      kind: job.kind === "INCREMENTAL" ? "INCREMENTAL" : "FULL",
      cursor: cursorIn ?? undefined,
    });
    for await (const batch of pages) {
      const r = await ingestBatch(
        { workspaceId: ctx.workspaceId, integrationId: integration.id, source },
        batch,
      );
      counts = addCounts(counts, r.counts);
      for (const pr of r.problems) if (problems.length < PROBLEM_CAP) problems.push(pr);
      for (const id of r.accountIds) accountIds.add(id);
      if (batch.cursor !== undefined) cursor = batch.cursor;
    }
  } catch (err) {
    const described = describe(err, integration.provider, name, deps);
    const credentialProblem =
      err instanceof ProviderHttpError && (err.status === 401 || err.status === 403);
    await db.$tenantTransaction(async (tx) => {
      await tx.syncJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          finishedAt: realClock(),
          counts: { ...counts, problems } as unknown as Prisma.InputJsonObject,
          errorPlain: [described.plain, described.action].filter(Boolean).join(" "),
        },
      });
      await tx.integration.update({
        where: { id: integration.id },
        data: {
          lastErrorPlain: described.plain,
          ...(credentialProblem ? { status: "ERROR" as const } : {}),
        },
      });
    });
    logger.warn(
      {
        workspaceId: ctx.workspaceId,
        integrationId: integration.id,
        syncJobId: job.id,
        error: err instanceof Error ? err.name : "unknown",
      },
      "integration sync failed",
    );
    if (err instanceof UnfixturedRequestError) throw err;
    return { status: "FAILED", syncJobId: job.id, counts, errorPlain: described.plain };
  }

  await db.$tenantTransaction(async (tx) => {
    await tx.syncJob.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        finishedAt: realClock(),
        cursor,
        counts: { ...counts, problems } as unknown as Prisma.InputJsonObject,
      },
    });
    await tx.integration.update({
      where: { id: integration.id },
      data: { lastSyncAt: realClock(), lastErrorPlain: null, status: "CONNECTED" },
    });
    await writeOutboxEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: "sync.completed",
      payload: {
        integrationId: integration.id,
        syncJobId: job.id,
        provider: integration.provider,
        accountIds: [...accountIds].slice(0, ACCOUNT_ID_CAP),
        counts: { ...counts },
      },
    });
  });
  return { status: "SUCCEEDED", syncJobId: job.id, counts };
}

/** The adapter's own wording when there is one, else the framework's. */
function describe(
  err: unknown,
  provider: Parameters<typeof adapterFor>[0],
  name: string,
  deps: ConnectionDeps,
) {
  try {
    return (deps.adapter ?? adapterFor)(provider).describeError(err);
  } catch {
    return describeProviderError(err, name, `Reconnect ${name}.`);
  }
}

// ─── Enqueueing ──────────────────────────────────────────────────────────────

const JOB_OPTS = { attempts: 2, backoff: { type: "exponential", delay: 5_000 } } as const;

export async function syncableIntegrations(ctx: TenantContext) {
  return scopedDb(ctx).integration.findMany({
    where: { provider: { in: [...SYNCABLE] }, status: { not: "DISCONNECTED" } },
    select: { id: true, provider: true },
    orderBy: { connectedAt: "asc" },
  });
}

/**
 * The nightly flow (ARCHITECTURE §1.2 step 2): one `sync.run` child per connected data
 * integration under a parent `nightly.kickoff` that fans out signals and health once every child
 * has finished. Ids are dedupe-intended (business date + run id, D-81): re-running the same
 * nightly run adds nothing. A failed child does not hold the nightly run back.
 * Returns how many syncs the run waits for (0 = no integrations, nothing added).
 */
export async function addNightlySyncFlow(
  ctx: TenantContext,
  run: { asOf: string; runId: string },
): Promise<number> {
  const integrations = await syncableIntegrations(ctx);
  if (integrations.length === 0) return 0;
  await getFlowProducer().add({
    name: "nightly.kickoff",
    queueName: "signals",
    data: { workspaceId: ctx.workspaceId, asOf: run.asOf, runId: run.runId, afterSync: true },
    opts: { jobId: `${ctx.workspaceId}.after-sync.${run.asOf}.${run.runId}`, ...JOB_OPTS },
    children: integrations.map((i) => ({
      name: "sync.run",
      queueName: "sync",
      data: {
        workspaceId: ctx.workspaceId,
        integrationId: i.id,
        kind: "INCREMENTAL",
        trigger: "NIGHTLY",
        runKey: run.runId,
      } satisfies SyncRunPayload,
      opts: {
        jobId: `${ctx.workspaceId}.sync.${i.id}.${run.asOf}.${run.runId}`,
        ignoreDependencyOnFailure: true,
        ...JOB_OPTS,
      },
    })),
  });
  return integrations.length;
}

/** "Run sync now" (and the setup import): one job per request, never deduped (D-81). */
export async function enqueueSync(
  ctx: TenantContext,
  integrationId: string,
  trigger: "MANUAL" | "SETUP",
  kind: "FULL" | "INCREMENTAL" = "INCREMENTAL",
) {
  const runKey = manualRunId();
  await getQueue("sync").add(
    "sync.run",
    { workspaceId: ctx.workspaceId, integrationId, kind, trigger, runKey } satisfies SyncRunPayload,
    { jobId: `${ctx.workspaceId}.sync.${integrationId}.${runKey}`, ...JOB_OPTS },
  );
  return { runKey };
}
