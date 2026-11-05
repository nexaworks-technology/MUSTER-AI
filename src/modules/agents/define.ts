import type { AccountTier, ApprovalLevel, Prisma } from "@prisma/client";
import type { z } from "zod";
import type { ModelTier } from "@/lib/ai";
import type { ScopedDb, TenantContext } from "@/lib/db/scoped";
import type { BaseAgentOutput, ContextBundle } from "./schemas";

/**
 * An agent is a code definition (ARCHITECTURE §6.1). One job each; every run is an AgentRun.
 * Model names never appear here: a tier maps to AI_MODEL_FAST / _STANDARD / _DEEP.
 */
export interface BuiltContext {
  bundle: ContextBundle;
  /** Values for the prompt's {{placeholders}}. */
  vars: Record<string, string>;
  accountId?: string;
  /** Deterministic numbers that overwrite forbidden numeric fields in proposed actions. */
  facts?: Record<string, number>;
  /** Optional prompt override for multi-mode agents (e.g. meeting-qbr). */
  prompt?: { name: string; version: string };
  /** Optional model tier override for multi-mode agents. */
  tier?: ModelTier;
}

/** What a side effect wrote, recorded on AgentRun.effects (Rule 5). */
export interface Effect {
  type: string;
  id: string;
}

export interface ActContext {
  db: ScopedDb;
  workspaceId: string;
  runId: string;
  accountId: string | null;
  bundle: ContextBundle;
  /** The run's input, already parsed with the agent's inputSchema. */
  input: unknown;
  /** `runId:index`, unique on every side-effect table: a retried run never writes twice. */
  sourceKey: (index: number) => string;
  signalId?: string | null;
}

export interface ActResult {
  effects: Effect[];
  actionTaken: "NONE" | "DRAFTED" | "APPROVAL_REQUESTED" | "TASK_CREATED" | "NOTIFIED" | "EXECUTED";
}

export interface AgentDef<I = unknown, O extends BaseAgentOutput = BaseAgentOutput> {
  key: string;
  /** Code version; bump on any schema or behaviour change. Part of the idempotency key. */
  version: string;
  description: string;
  modelTier: ModelTier;
  /** One line on why this tier (ARCHITECTURE §6.1). */
  tierReason: string;
  prompt: { name: string; version: string };
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  buildContext: (db: ScopedDb, input: I, ctx: TenantContext) => Promise<BuiltContext>;
  /** Extra citations carried in agent-specific fields (e.g. citesReasonIds). */
  extraCitations?: (output: O) => Array<{ sourceType: string; sourceId: string }>;
  /** Claims the agent made without naming any evidence (each one makes the run UNCITED). */
  uncited?: (output: O) => string[];
  /** Narrative strings whose numbers must appear in cited records (founder point 6). */
  narrative?: (output: O) => string[];
  forbiddenNumericFields: readonly string[];
  /** "INTERNAL" for agents whose output never leaves the workspace. */
  approvalPolicy: "INTERNAL" | Record<AccountTier, ApprovalLevel>;
  /** Side effects, run only after the output is persisted; each keyed by sourceKey(index). */
  act?: (output: O, ctx: ActContext) => Promise<ActResult>;
}

export function defineAgent<I, O extends BaseAgentOutput>(def: AgentDef<I, O>): AgentDef<I, O> {
  return def;
}

/**
 * The registry and the executor hold agents of different input and output types. The types are
 * erased here only: every run Zod-parses its input with def.inputSchema and its output with
 * def.outputSchema before anything is used, so nothing unchecked reaches a record.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- type erasure, see above
export type AnyAgentDef = AgentDef<any, any>;
export type JsonValue = Prisma.InputJsonValue;
