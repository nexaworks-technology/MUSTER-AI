import type { AgentRun } from "@prisma/client";
import { isAiConfigured } from "@/lib/ai";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";

/**
 * The agents module's public surface (ARCHITECTURE §2, §6). Other modules define agents with
 * defineAgent, run them with runAgent, and read what may be shown with renderableRun.
 */
export {
  defineAgent,
  type AgentDef,
  type AnyAgentDef,
  type ActContext,
  type ActResult,
  type BuiltContext,
  type Effect,
} from "./define";
export {
  runAgent,
  createOnce,
  idempotencyKey,
  backoffMs,
  MAX_ATTEMPTS,
  type ExecutorDeps,
  type RunOutcome,
  type Trigger,
} from "./executor";
export { evaluateOutput, type Evaluation } from "./evaluate";
export { registerAgent, getAgent, listAgents, checkAgentPrompts } from "./registry";
export { recordText, normalizeWhitespace } from "./validate";
export * from "./schemas";

/** "AI is not configured" instead of fake output (ARCHITECTURE §8.3). */
export const aiConfigured = (): boolean => isAiConfigured();

/**
 * The only way to read a run for display (§6.4): SUCCEEDED or nothing. INVALID_OUTPUT, UNCITED,
 * FAILED and SKIPPED runs render nothing, whatever they contain.
 */
export async function renderableRun(ctx: TenantContext, runId: string): Promise<AgentRun | null> {
  return scopedDb(ctx).agentRun.findFirst({ where: { id: runId, status: "SUCCEEDED" } });
}

export {
  enqueueAgent,
  processAgentRun,
  agentRunPayload,
  processConsider,
  sweepAllHealthNarratives,
} from "./jobs";
export {
  considerHealthNarrative,
  needsNarrative,
  topReasonKey,
  sweepHealthNarratives,
} from "./definitions/health-analyst-trigger";
export {
  healthAnalyst,
  healthAnalystOutput,
  type HealthAnalystOutput,
} from "./definitions/health-analyst";
export { healthNarrative, type Narrative } from "./narrative";
export { judge, loadGolden, GOLDEN_DIR, type GoldenCase, type Verdict } from "./golden";
export {
  watcher,
  watcherOutput,
  watcherInput,
  WATCHER_PROMPT,
  backfillExtractions,
} from "./definitions/watcher";
