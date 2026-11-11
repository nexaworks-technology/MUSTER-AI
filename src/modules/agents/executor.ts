import { createHash } from "node:crypto";
import { Prisma, type AgentRun } from "@prisma/client";
import {
  AiNotConfiguredError,
  AiProviderError,
  AiTransientError,
  getAiProvider,
  isAiConfigured,
  loadPrompt,
  renderPrompt,
  type AiProvider,
  type BatchItem,
  type StructuredRequest,
  type StructuredResult,
} from "@/lib/ai";
import { writeAudit } from "@/lib/audit";
import { startOfLocalDay, businessClock, todayIn, type Clock } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { logger } from "@/lib/logger";
import { getSettingsData } from "@/modules/settings/service";
import type { ActResult, AnyAgentDef, BuiltContext } from "./define";
import { resolveHandles, withHandles } from "./aliases";
import { isPausedForBudget, noteBudgetUsage } from "./budget";
import { evaluateOutput } from "./evaluate";

/**
 * The agent run executor (ARCHITECTURE §1.3, §6.3; D-74). One AgentRun per idempotency key.
 * Statuses: QUEUED → RUNNING → SUCCEEDED / INVALID_OUTPUT / UNCITED / FAILED / SKIPPED. Nothing
 * is written in place of a failed run: a refusal, an error or an invalid answer leaves only the
 * run row that says so.
 */
export const MAX_ATTEMPTS = 5; // the first call + 4 retries on transient provider errors (D-74)
/**
 * A person is waiting (Ask AI): at most this many attempts in all, and a timeout is never retried
 * (a timeout already cost a full request time; retrying multiplies cost and latency).
 */
export const INTERACTIVE_MAX_ATTEMPTS = 2;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;

export interface ExecutorDeps {
  provider?: AiProvider;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  promptsDir?: string;
  /**
   * Sweeps and batches (docs/AI-COST-2026-11-11.md, item 4): when the exact records and prompt this
   * run would send equal those of the agent's last SUCCEEDED run on the same account, make no
   * model call and write no run. Off for a person's own request, so asking again always answers.
   */
  skipIfUnchanged?: boolean;
  /**
   * A person is waiting on this run: at most INTERACTIVE_MAX_ATTEMPTS attempts and no retry after a
   * timeout. Background jobs leave it off and keep the patient D-74 retry policy.
   */
  interactive?: boolean;
  /** Per-request timeout in ms passed to the provider (default 60 s). */
  timeoutMs?: number;
  /** Finds an agent by key when a batch result is collected; defaults to the registry. */
  resolveAgent?: (key: string) => AnyAgentDef;
}

export type RunOutcome =
  | { kind: "not_configured"; reason: string }
  | {
      kind: "run";
      runId: string;
      status: AgentRun["status"];
      reused: boolean;
      /** Set when nothing changed since the last successful run, so no model call was made. */
      unchanged?: true;
    };

interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}
const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

export interface Trigger {
  type: string;
  id: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** sha256(workspaceId, agentKey, agentVersion, triggerType, triggerId, inputHash) (M4 §2). */
export function idempotencyKey(
  workspaceId: string,
  def: Pick<AnyAgentDef, "key" | "version">,
  trigger: Trigger,
  inputHash: string,
): string {
  return sha256(
    [workspaceId, def.key, def.version, trigger.type, trigger.id, inputHash].join("\u0000"),
  );
}

export function inputHashOf(input: unknown, built: BuiltContext): string {
  return sha256(JSON.stringify({ input, bundle: built.bundle, vars: built.vars }));
}

/** Exponential backoff with jitter: 2 s, 4 s, 8 s, 16 s (+ up to 50 %), capped at 60 s. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.round(base * (1 + 0.5 * random()));
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

function renderInput(built: BuiltContext): string {
  return [
    "Records you may use. Cite each one you rely on by its sourceType and sourceId.",
    "Quote only words that appear in the record. Repeat only numbers that appear in a record you cite.",
    JSON.stringify(built.aliasRefs ? withHandles(built.bundle) : built.bundle, null, 2),
  ].join("\n\n");
}

async function spentToday(ctx: TenantContext, clock: Clock): Promise<number> {
  const ws = await getOwnWorkspace(ctx);
  const since = startOfLocalDay(todayIn(ws.timezone, clock), ws.timezone);
  const sum = await scopedDb(ctx).agentRun.aggregate({
    where: { createdAt: { gte: since } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  return (sum._sum.inputTokens ?? 0) + (sum._sum.outputTokens ?? 0);
}

/**
 * Everything a run sends to the model, built exactly once per run from scoped records: the parsed
 * input, the context bundle, the prompt, and the request (system + input). The recorded-provider
 * fixture script uses this too, so a recording always matches what a real run would send.
 */
export async function prepareRun(
  ctx: TenantContext,
  def: AnyAgentDef,
  rawInput: unknown,
  promptsDir?: string,
) {
  const input = def.inputSchema.parse(rawInput);
  const built = await def.buildContext(scopedDb(ctx), input, ctx);
  const promptMeta = built.prompt ?? def.prompt;
  const prompt = await loadPrompt(promptMeta.name, promptMeta.version, promptsDir);
  return {
    input,
    built,
    prompt,
    request: {
      tier: built.tier ?? def.modelTier,
      workspaceId: ctx.workspaceId,
      promptRef: prompt.ref,
      system: renderPrompt(prompt.body, built.vars),
      input: renderInput(built),
    },
  };
}

const addTokens = (
  t: Tokens,
  r: Pick<StructuredResult<unknown>, "inputTokens" | "outputTokens"> & {
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  },
): Tokens => ({
  input: t.input + r.inputTokens,
  output: t.output + r.outputTokens,
  cacheRead: t.cacheRead + (r.cacheReadTokens ?? 0),
  cacheCreation: t.cacheCreation + (r.cacheCreationTokens ?? 0),
});

/** Everything `execute` needs about one run that has been created and passed its pre-checks. */
interface Prepared {
  ctx: TenantContext;
  def: AnyAgentDef;
  run: AgentRun;
  reused: boolean;
  built: BuiltContext;
  input: unknown;
  prompt: Awaited<ReturnType<typeof loadPrompt>>;
  request: Omit<StructuredRequest<unknown>, "schema">;
  inputHash: string;
  deps: ExecutorDeps;
  clock: Clock;
}

/**
 * The part of a run before any model call: build the context, apply the unchanged gate, create (or
 * find) the run, and apply the switch-off and budget checks. Shared by real-time runs and batches,
 * so every route into a model call passes the same gates.
 */
async function begin(
  ctx: TenantContext,
  def: AnyAgentDef,
  rawInput: unknown,
  trigger: Trigger,
  deps: ExecutorDeps,
): Promise<{ done: RunOutcome } | { ready: Prepared }> {
  if (!deps.provider && !isAiConfigured())
    return { done: { kind: "not_configured", reason: "ANTHROPIC_API_KEY is not set" } };
  const clock = deps.clock ?? businessClock;
  const db = scopedDb(ctx);
  const { input, built, prompt, request } = await prepareRun(ctx, def, rawInput, deps.promptsDir);
  const inputHash = inputHashOf(input, built);
  const key = idempotencyKey(ctx.workspaceId, def, trigger, inputHash);

  if (deps.skipIfUnchanged) {
    // Same agent version and prompt version, same account, byte-identical records and variables:
    // the answer would be the same, so there is nothing to ask (and nothing to batch).
    const last = await db.agentRun.findFirst({
      where: {
        agentKey: def.key,
        agentVersion: def.version,
        promptName: prompt.name,
        promptVersion: prompt.version,
        accountId: built.accountId ?? null,
        inputHash,
        status: "SUCCEEDED",
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });
    if (last)
      return {
        done: { kind: "run", runId: last.id, status: last.status, reused: true, unchanged: true },
      };
  }

  let run: AgentRun;
  let reused = false;
  try {
    run = await db.agentRun.create({
      data: {
        workspaceId: ctx.workspaceId,
        agentKey: def.key,
        agentVersion: def.version,
        promptName: prompt.name,
        promptVersion: prompt.version,
        modelTier: request.tier,
        triggerType: trigger.type,
        triggerId: trigger.id,
        idempotencyKey: key,
        inputHash,
        inputRefs: json(
          built.bundle.map((r) => ({ sourceType: r.sourceType, sourceId: r.sourceId })),
        ),
        accountId: built.accountId ?? null,
        status: "QUEUED",
      },
    });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    run = await db.agentRun.findUniqueOrThrow({
      where: { workspaceId_idempotencyKey: { workspaceId: ctx.workspaceId, idempotencyKey: key } },
    });
    reused = true;
  }

  if (run.status === "SUCCEEDED") {
    // A crash after persist: re-apply the side effects; their sourceKeys make this a no-op twice.
    await applyEffects(ctx, def, run, built, input);
    return { done: { kind: "run", runId: run.id, status: run.status, reused } };
  }
  if (run.status !== "QUEUED" && run.status !== "RUNNING")
    return { done: { kind: "run", runId: run.id, status: run.status, reused } };
  // Already submitted in a batch and waiting for its result: never submit or call it twice.
  if (run.status === "RUNNING" && run.batchId)
    return { done: { kind: "run", runId: run.id, status: run.status, reused } };

  // An Admin can switch an agent off for this workspace (Settings › AI team).
  const definition = await db.agentDefinition.findUnique({
    where: { workspaceId_agentKey: { workspaceId: ctx.workspaceId, agentKey: def.key } },
    select: { enabled: true },
  });
  if (definition && !definition.enabled)
    return {
      done: await finish(
        ctx,
        def,
        run,
        {
          status: "SKIPPED",
          errorCode: "DISABLED",
          errorDetail: "This agent is switched off for the workspace.",
        },
        reused,
      ),
    };

  const settings = await getSettingsData(ctx.workspaceId);
  if ((await spentToday(ctx, clock)) >= settings.ai.dailyTokenBudget)
    return {
      done: await finish(
        ctx,
        def,
        run,
        { status: "SKIPPED", errorCode: "BUDGET", errorDetail: "budget" },
        reused,
      ),
    };
  // The month's budget is used up: everything pauses except the essential jobs (Ask AI).
  if (await isPausedForBudget(ctx, def.key, clock))
    return {
      done: await finish(
        ctx,
        def,
        run,
        {
          status: "SKIPPED",
          errorCode: "MONTHLY_BUDGET",
          errorDetail:
            "The workspace's monthly AI token budget is used up. This job resumes next month or when the budget is raised; Ask AI keeps working.",
        },
        reused,
      ),
    };

  return {
    ready: { ctx, def, run, reused, built, input, prompt, request, inputHash, deps, clock },
  };
}

/** A batch item as the same result shape a real-time call returns, parsed with the agent's schema. */
function resultFromBatchItem(
  item: Extract<BatchItem, { outcome: "succeeded" }>,
  def: AnyAgentDef,
): StructuredResult<unknown> {
  const base = {
    stopReason: item.stopReason,
    model: item.model,
    requestId: item.requestId,
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    cacheReadTokens: item.cacheReadTokens,
    cacheCreationTokens: item.cacheCreationTokens,
    latencyMs: 0,
  };
  if (item.stopReason === "refusal" || item.text === null)
    return { ...base, output: null, stopReason: item.stopReason ?? "invalid_output" };
  let raw: unknown;
  try {
    raw = JSON.parse(item.text);
  } catch {
    return {
      ...base,
      output: null,
      stopReason: "invalid_output",
      validationError: "the answer was not valid JSON",
    };
  }
  const parsed = def.outputSchema.safeParse(raw);
  return parsed.success
    ? { ...base, output: parsed.data }
    : {
        ...base,
        output: null,
        stopReason: "invalid_output",
        validationError: parsed.error.message.slice(0, 2_000),
      };
}

/**
 * Everything after the pre-checks: the model call with retries (unless `first` is a result already
 * in hand, from a batch), the one repair call, the citation and safety evaluation, persisting the
 * output, and the side effects. A batch result goes through exactly this code, so it faces the same
 * citation checker, forbidden-number rules and schema as a real-time answer.
 */
async function execute(b: Prepared, first?: StructuredResult<unknown>): Promise<RunOutcome> {
  const { ctx, def, run, reused, built, input, prompt, deps } = b;
  const db = scopedDb(ctx);
  const provider = deps.provider ?? getAiProvider();
  const request = {
    ...b.request,
    schema: def.outputSchema,
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
  };

  const started = first && run.startedAt ? +run.startedAt : Date.now();
  let tokens = NO_TOKENS;
  const add = (r: StructuredResult<unknown>) => {
    tokens = addTokens(tokens, r);
  };

  let attempt = run.attempt;
  const call = async (
    req: typeof request,
  ): Promise<StructuredResult<unknown> | { error: Error }> => {
    for (;;) {
      attempt += 1;
      await db.agentRun.update({
        where: { id: run.id },
        data: { status: "RUNNING", attempt, startedAt: run.startedAt ?? new Date() },
      });
      try {
        return await provider.generateStructured<unknown>(req);
      } catch (error) {
        const retryable =
          error instanceof AiTransientError &&
          (deps.interactive
            ? attempt < INTERACTIVE_MAX_ATTEMPTS && error.code !== "timeout"
            : attempt < MAX_ATTEMPTS);
        if (error instanceof AiTransientError && retryable) {
          logger.warn(
            { runId: run.id, agentKey: def.key, attempt, code: error.code },
            "agent retry",
          );
          await (deps.sleep ?? defaultSleep)(backoffMs(attempt, deps.random));
          continue;
        }
        return { error: error instanceof Error ? error : new Error(String(error)) };
      }
    }
  };

  const failed = (error: Error) =>
    finish(
      ctx,
      def,
      run,
      {
        status: "FAILED",
        errorCode:
          error instanceof AiTransientError || error instanceof AiProviderError
            ? `PROVIDER_${error.code.toUpperCase()}`
            : error instanceof AiNotConfiguredError
              ? "NOT_CONFIGURED"
              : "ERROR",
        errorDetail: error.message.slice(0, 500),
        tokens,
        latencyMs: Date.now() - started,
      },
      reused,
    );

  let result: StructuredResult<unknown>;
  if (first) result = first;
  else {
    const r = await call(request);
    if ("error" in r) return failed(r.error);
    result = r;
  }
  add(result);
  const declined = (r: StructuredResult<unknown>) =>
    finish(
      ctx,
      def,
      run,
      {
        status: "FAILED",
        errorCode: "MODEL_DECLINED",
        errorDetail: "The model declined to answer. Nothing was written in its place (D-74).",
        model: r.model,
        tokens,
        latencyMs: Date.now() - started,
      },
      reused,
    );
  if (result.stopReason === "refusal") return declined(result);

  if (result.output === null) {
    // Exactly one repair call (D-74), then INVALID_OUTPUT. Real time, even for a batched run.
    const repaired = await call({
      ...request,
      input: `${request.input}\n\nYour previous answer did not match the required format (${
        result.validationError ?? "schema mismatch"
      }). Answer again in the required format, using only the records above.`,
    });
    if ("error" in repaired) return failed(repaired.error);
    add(repaired);
    if (repaired.stopReason === "refusal") return declined(repaired);
    result = repaired;
    if (result.output === null)
      return finish(
        ctx,
        def,
        run,
        {
          status: "INVALID_OUTPUT",
          errorCode: "INVALID_OUTPUT",
          errorDetail: (result.validationError ?? "output did not match the schema").slice(0, 500),
          model: result.model,
          tokens,
          latencyMs: Date.now() - started,
        },
        reused,
      );
  }

  // Handle citations become the real records first; the checker below is unchanged.
  const candidate = built.aliasRefs ? resolveHandles(result.output, built.bundle) : result.output;
  const evaluation = evaluateOutput(def, built.bundle, candidate, built.facts);
  if (evaluation.status !== "SUCCEEDED")
    return finish(
      ctx,
      def,
      run,
      {
        status: evaluation.status,
        errorCode: evaluation.status,
        errorDetail: evaluation.problems.join("; ").slice(0, 1_000),
        model: result.model,
        tokens,
        latencyMs: Date.now() - started,
      },
      reused,
    );

  const succeeded = await db.$tenantTransaction(async (tx) => {
    const row = await tx.agentRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCEEDED",
        output: json(evaluation.output),
        reasoningSummary: evaluation.output.reasoningSummary,
        confidence: evaluation.output.confidence,
        citations: json(evaluation.output.citations),
        model: result.model,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadTokens: tokens.cacheRead,
        cacheCreationTokens: tokens.cacheCreation,
        latencyMs: Date.now() - started,
        finishedAt: new Date(),
        errorCode: null,
        errorDetail: null,
      },
    });
    await writeAudit(
      {
        workspaceId: ctx.workspaceId,
        actorType: "AGENT",
        actorId: def.key,
        action: "agent.run.succeeded",
        targetType: "AgentRun",
        targetId: run.id,
        agentRunId: run.id,
        summary: `${def.key} v${def.version} succeeded (${prompt.ref})`,
        after: { inputRefs: row.inputRefs, confidence: row.confidence },
      },
      tx,
    );
    return row;
  });
  logger.info({ runId: run.id, agentKey: def.key, status: "SUCCEEDED" }, "agent run");
  await applyEffects(ctx, def, succeeded, built, input);
  return { kind: "run", runId: run.id, status: "SUCCEEDED", reused };
}

/** The soft alert is housekeeping: it must never fail or delay a run. */
async function noteBudgetSafely(ctx: TenantContext, clock: Clock): Promise<void> {
  try {
    await noteBudgetUsage(ctx, clock);
  } catch (error) {
    logger.warn({ workspaceId: ctx.workspaceId, err: error }, "ai budget alert failed");
  }
}

/**
 * Runs one agent for one trigger, in real time. Safe to call again with the same trigger: the run
 * is found by its key; a SUCCEEDED run only re-applies its (idempotent) side effects; a terminal
 * failure is returned as it is; an interrupted run resumes.
 */
export async function runAgent(
  ctx: TenantContext,
  def: AnyAgentDef,
  rawInput: unknown,
  trigger: Trigger,
  deps: ExecutorDeps = {},
): Promise<RunOutcome> {
  const begun = await begin(ctx, def, rawInput, trigger, deps);
  if ("done" in begun) return begun.done;
  const outcome = await execute(begun.ready);
  await noteBudgetSafely(ctx, begun.ready.clock);
  return outcome;
}

export interface BulkJob {
  def: AnyAgentDef;
  input: unknown;
  trigger: Trigger;
}

/**
 * Bulk and nightly work (docs/AI-COST-2026-11-11.md, item 2): every job that passes the gates is
 * sent to the provider as ONE batch (half price, results within a day) instead of one call each.
 * Jobs whose records are unchanged since their last successful run are left out entirely: no call
 * and no batch entry. Each submitted run is RUNNING with its batch id until `collectBatches`
 * reads the results. A provider without batch support runs the jobs in real time instead.
 * Interactive work (Ask AI, approvals, in-app actions) never uses this.
 */
export async function runAgentsBatch(
  ctx: TenantContext,
  jobs: BulkJob[],
  deps: ExecutorDeps = {},
): Promise<RunOutcome[]> {
  const gated: ExecutorDeps = { ...deps, skipIfUnchanged: deps.skipIfUnchanged ?? true };
  const clock = gated.clock ?? businessClock;
  const outcomes: RunOutcome[] = new Array<RunOutcome>(jobs.length);
  const ready: Array<{ i: number; b: Prepared }> = [];
  for (const [i, j] of jobs.entries()) {
    const begun = await begin(ctx, j.def, j.input, j.trigger, gated);
    if ("done" in begun) outcomes[i] = begun.done;
    else ready.push({ i, b: begun.ready });
  }
  if (ready.length === 0) return outcomes;

  const provider = gated.provider ?? getAiProvider();
  if (!provider.submitBatch) {
    for (const { i, b } of ready) outcomes[i] = await execute(b);
    await noteBudgetSafely(ctx, clock);
    return outcomes;
  }

  const db = scopedDb(ctx);
  let batchId: string;
  try {
    ({ batchId } = await provider.submitBatch(
      ready.map(({ b }) => ({ ...b.request, schema: b.def.outputSchema, customId: b.run.id })),
    ));
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    for (const { i, b } of ready)
      outcomes[i] = await finish(
        ctx,
        b.def,
        b.run,
        {
          status: "FAILED",
          errorCode:
            err instanceof AiTransientError || err instanceof AiProviderError
              ? `PROVIDER_${err.code.toUpperCase()}`
              : err instanceof AiNotConfiguredError
                ? "NOT_CONFIGURED"
                : "ERROR",
          errorDetail: err.message.slice(0, 500),
        },
        b.reused,
      );
    return outcomes;
  }
  const now = new Date();
  for (const { i, b } of ready) {
    await db.agentRun.update({
      where: { id: b.run.id },
      data: { status: "RUNNING", attempt: 1, startedAt: now, batchId, batchInput: json(b.input) },
    });
    outcomes[i] = { kind: "run", runId: b.run.id, status: "RUNNING", reused: b.reused };
  }
  logger.info(
    { workspaceId: ctx.workspaceId, batchId, runs: ready.length },
    "agent batch submitted",
  );
  // A provider that answers at once (the recorded one) finishes now; a real batch usually has not.
  await collectBatches(ctx, { ...gated, provider });
  // Report what each submitted run is now, not what it was when it was submitted.
  const now2 = await db.agentRun.findMany({
    where: { id: { in: ready.map(({ b }) => b.run.id) } },
    select: { id: true, status: true },
  });
  const statusOf = new Map(now2.map((r) => [r.id, r.status]));
  for (const { i, b } of ready)
    outcomes[i] = {
      kind: "run",
      runId: b.run.id,
      status: statusOf.get(b.run.id) ?? "RUNNING",
      reused: b.reused,
    };
  return outcomes;
}

/**
 * Reads every finished batch for the workspace and finishes its runs through `execute`. Each run's
 * records are rebuilt and must hash exactly as they did at submit time; if anything changed while
 * the batch ran, the run is SKIPPED (STALE_BATCH_INPUT) rather than checked against different
 * records, and the next sweep picks the account up again. Safe to call repeatedly.
 */
export async function collectBatches(
  ctx: TenantContext,
  deps: ExecutorDeps = {},
): Promise<{ batches: number; finished: number }> {
  const db = scopedDb(ctx);
  const pending = await db.agentRun.findMany({
    where: { status: "RUNNING", batchId: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  if (pending.length === 0) return { batches: 0, finished: 0 };
  const provider = deps.provider ?? (isAiConfigured() ? getAiProvider() : undefined);
  if (!provider?.getBatch) return { batches: 0, finished: 0 };
  const clock = deps.clock ?? businessClock;
  // Imported on demand: the registry reaches the executor through the agent definitions.
  const registry = deps.resolveAgent ? null : await import("./registry");
  const resolve = (key: string): AnyAgentDef =>
    deps.resolveAgent ? deps.resolveAgent(key) : registry!.getAgent(key);

  const byBatch = new Map<string, AgentRun[]>();
  for (const r of pending) byBatch.set(r.batchId!, [...(byBatch.get(r.batchId!) ?? []), r]);
  let batches = 0;
  let finished = 0;
  for (const [batchId, runs] of byBatch) {
    let status;
    try {
      status = await provider.getBatch(batchId);
    } catch (error) {
      logger.warn({ batchId, err: error }, "agent batch poll failed; will retry");
      continue;
    }
    if (!status.done) continue;
    batches++;
    const items = new Map(status.items.map((it) => [it.customId, it]));
    for (const run of runs) {
      const def = resolve(run.agentKey);
      const item = items.get(run.id);
      if (!item || item.outcome !== "succeeded") {
        await finish(
          ctx,
          def,
          run,
          {
            status: "FAILED",
            errorCode: `PROVIDER_${(item?.code ?? "missing_result").toUpperCase()}`,
            errorDetail: (item?.detail ?? "the batch returned no result for this run").slice(
              0,
              500,
            ),
          },
          true,
        );
        finished++;
        continue;
      }
      try {
        const prep = await prepareRun(ctx, def, run.batchInput, deps.promptsDir);
        if (inputHashOf(prep.input, prep.built) !== run.inputHash) {
          await finish(
            ctx,
            def,
            run,
            {
              status: "SKIPPED",
              errorCode: "STALE_BATCH_INPUT",
              errorDetail:
                "The account's records changed while the batch ran, so the answer was not used. The next sweep asks again.",
              model: item.model,
              tokens: addTokens(NO_TOKENS, item),
            },
            true,
          );
        } else {
          await execute(
            {
              ctx,
              def,
              run,
              reused: true,
              built: prep.built,
              input: prep.input,
              prompt: prep.prompt,
              request: prep.request,
              inputHash: run.inputHash ?? "",
              deps: { ...deps, provider },
              clock,
            },
            resultFromBatchItem(item, def),
          );
        }
        finished++;
      } catch (error) {
        // Left RUNNING: the next pass tries this run again.
        logger.error({ runId: run.id, batchId, err: error }, "agent batch result not applied");
      }
    }
  }
  if (finished > 0) await noteBudgetSafely(ctx, clock);
  return { batches, finished };
}

interface Finish {
  status: "INVALID_OUTPUT" | "UNCITED" | "FAILED" | "SKIPPED";
  errorCode: string;
  errorDetail: string;
  model?: string;
  tokens?: Tokens;
  latencyMs?: number;
}

async function finish(
  ctx: TenantContext,
  def: AnyAgentDef,
  run: AgentRun,
  f: Finish,
  reused: boolean,
): Promise<RunOutcome> {
  await scopedDb(ctx).$tenantTransaction(async (tx) => {
    await tx.agentRun.update({
      where: { id: run.id },
      data: {
        status: f.status,
        errorCode: f.errorCode,
        errorDetail: f.errorDetail,
        model: f.model ?? run.model,
        inputTokens: f.tokens?.input ?? run.inputTokens,
        outputTokens: f.tokens?.output ?? run.outputTokens,
        cacheReadTokens: f.tokens?.cacheRead ?? run.cacheReadTokens,
        cacheCreationTokens: f.tokens?.cacheCreation ?? run.cacheCreationTokens,
        latencyMs: f.latencyMs ?? run.latencyMs,
        finishedAt: new Date(),
      },
    });
    await writeAudit(
      {
        workspaceId: ctx.workspaceId,
        actorType: "AGENT",
        actorId: def.key,
        action: `agent.run.${f.status.toLowerCase()}`,
        targetType: "AgentRun",
        targetId: run.id,
        agentRunId: run.id,
        summary: `${def.key} v${def.version}: ${f.status} (${f.errorCode})`,
      },
      tx,
    );
  });
  logger.info(
    { runId: run.id, agentKey: def.key, status: f.status, errorCode: f.errorCode },
    "agent run",
  );
  return { kind: "run", runId: run.id, status: f.status, reused };
}

async function applyEffects(
  ctx: TenantContext,
  def: AnyAgentDef,
  run: AgentRun,
  built: BuiltContext,
  input: unknown,
): Promise<void> {
  if (!def.act) return;
  const db = scopedDb(ctx);
  const parsed = def.outputSchema.parse(run.output);
  const result: ActResult = await def.act(parsed, {
    db,
    workspaceId: ctx.workspaceId,
    runId: run.id,
    accountId: run.accountId,
    bundle: built.bundle,
    input,
    sourceKey: (index) => `${run.id}:${index}`,
    signalId:
      run.triggerType === "signal"
        ? run.triggerId
        : (built.bundle.find((r) => r.sourceType === "Signal")?.sourceId ?? null),
  });
  await db.agentRun.update({
    where: { id: run.id },
    data: { effects: json(result.effects), actionTaken: result.actionTaken },
  });
}

/** Inserts a side-effect row once: a retry that hits the sourceKey unique returns the existing row. */
export async function createOnce<T>(
  create: () => Promise<T>,
  find: () => Promise<T | null>,
): Promise<T> {
  try {
    return await create();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await find();
      if (existing) return existing;
    }
    throw e;
  }
}
