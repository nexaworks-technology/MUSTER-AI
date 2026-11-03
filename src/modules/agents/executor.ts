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
  type StructuredResult,
} from "@/lib/ai";
import { writeAudit } from "@/lib/audit";
import { startOfLocalDay, systemClock, todayIn, type Clock } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { logger } from "@/lib/logger";
import { getSettingsData } from "@/modules/settings/service";
import type { ActResult, AnyAgentDef, BuiltContext } from "./define";
import { evaluateOutput } from "./evaluate";

/**
 * The agent run executor (ARCHITECTURE §1.3, §6.3; D-74). One AgentRun per idempotency key.
 * Statuses: QUEUED → RUNNING → SUCCEEDED / INVALID_OUTPUT / UNCITED / FAILED / SKIPPED. Nothing
 * is written in place of a failed run: a refusal, an error or an invalid answer leaves only the
 * run row that says so.
 */
export const MAX_ATTEMPTS = 5; // the first call + 4 retries on transient provider errors (D-74)
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;

export interface ExecutorDeps {
  provider?: AiProvider;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  promptsDir?: string;
}

export type RunOutcome =
  | { kind: "not_configured"; reason: string }
  | { kind: "run"; runId: string; status: AgentRun["status"]; reused: boolean };

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
    JSON.stringify(built.bundle, null, 2),
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
 * Runs one agent for one trigger. Safe to call again with the same trigger: the run is found by
 * its key; a SUCCEEDED run only re-applies its (idempotent) side effects; a terminal failure is
 * returned as it is; an interrupted run resumes.
 */
export async function runAgent(
  ctx: TenantContext,
  def: AnyAgentDef,
  rawInput: unknown,
  trigger: Trigger,
  deps: ExecutorDeps = {},
): Promise<RunOutcome> {
  if (!deps.provider && !isAiConfigured())
    return { kind: "not_configured", reason: "ANTHROPIC_API_KEY is not set" };
  const clock = deps.clock ?? systemClock;
  const db = scopedDb(ctx);
  const input = def.inputSchema.parse(rawInput);
  const built = await def.buildContext(db, input, ctx);
  const prompt = await loadPrompt(def.prompt.name, def.prompt.version, deps.promptsDir);
  const key = idempotencyKey(ctx.workspaceId, def, trigger, inputHashOf(input, built));

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
        modelTier: def.modelTier,
        triggerType: trigger.type,
        triggerId: trigger.id,
        idempotencyKey: key,
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
    return { kind: "run", runId: run.id, status: run.status, reused };
  }
  if (run.status !== "QUEUED" && run.status !== "RUNNING")
    return { kind: "run", runId: run.id, status: run.status, reused };

  const settings = await getSettingsData(ctx.workspaceId);
  if ((await spentToday(ctx, clock)) >= settings.ai.dailyTokenBudget)
    return finish(
      ctx,
      def,
      run,
      { status: "SKIPPED", errorCode: "BUDGET", errorDetail: "budget" },
      reused,
    );

  const provider = deps.provider ?? getAiProvider();
  const request = {
    tier: def.modelTier,
    workspaceId: ctx.workspaceId,
    promptRef: prompt.ref,
    system: renderPrompt(prompt.body, built.vars),
    input: renderInput(built),
    schema: def.outputSchema,
  };

  const started = Date.now();
  let tokens = { input: 0, output: 0 };
  const add = (r: StructuredResult<unknown>) => {
    tokens = { input: tokens.input + r.inputTokens, output: tokens.output + r.outputTokens };
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
        if (error instanceof AiTransientError && attempt < MAX_ATTEMPTS) {
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

  let result = await call(request);
  if ("error" in result) return failed(result.error);
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
    // Exactly one repair call (D-74), then INVALID_OUTPUT.
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

  const evaluation = evaluateOutput(def, built.bundle, result.output, built.facts);
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

interface Finish {
  status: "INVALID_OUTPUT" | "UNCITED" | "FAILED" | "SKIPPED";
  errorCode: string;
  errorDetail: string;
  model?: string;
  tokens?: { input: number; output: number };
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
