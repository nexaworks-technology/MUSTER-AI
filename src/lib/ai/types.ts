import type { z } from "zod";

/**
 * The provider seam every agent will use (ARCHITECTURE §6). Model names are never written in
 * feature code: a tier maps to AI_MODEL_FAST / AI_MODEL_STANDARD / AI_MODEL_DEEP.
 */
export type ModelTier = "fast" | "standard" | "deep";

export interface StructuredRequest<T> {
  tier: ModelTier;
  /** Workspace the call serves — logged as an id only, never sent anywhere else (Rule 8). */
  workspaceId: string;
  /** `name@version` of the prompt file, for logs and recordings. */
  promptRef: string;
  system: string;
  input: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  /** Per-request timeout in ms; the provider default (60 s) applies when absent. */
  timeoutMs?: number;
}

export interface StructuredResult<T> {
  /** Null when the model declined or its output failed validation — never guessed. */
  output: T | null;
  stopReason: string | null;
  model: string;
  requestId: string | null;
  /** Uncached input tokens (the provider reports cache reads and writes separately). */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the prompt cache (billed at a tenth of the input price). */
  cacheReadTokens?: number;
  /** Input tokens written to the prompt cache (billed at 1.25× the input price). */
  cacheCreationTokens?: number;
  latencyMs: number;
  /** Why the output did not match the schema (issue paths and expectations), for the one repair call. */
  validationError?: string;
}

/** One request inside a batch; `customId` is the AgentRun id, so results map back to runs. */
export interface BatchRequest extends StructuredRequest<unknown> {
  customId: string;
}

/**
 * One finished batch request. A success carries the model's raw text; the caller parses it with
 * the request's own schema (the provider never sees a schema again after submitting).
 */
export type BatchItem =
  | {
      customId: string;
      outcome: "succeeded";
      text: string | null;
      stopReason: string | null;
      model: string;
      requestId: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  | { customId: string; outcome: "errored" | "expired" | "canceled"; code: string; detail: string };

export interface BatchStatus {
  /** True once every request has a result (or expired/was cancelled). */
  done: boolean;
  items: BatchItem[];
}

export interface AiProvider {
  readonly name: "anthropic" | "recorded";
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
  /**
   * Bulk jobs only (Message Batches API, half price, results within 24 h). A provider without
   * these is used in real time by every caller.
   */
  submitBatch?(requests: BatchRequest[]): Promise<{ batchId: string }>;
  getBatch?(batchId: string): Promise<BatchStatus>;
}

/** Shown in the UI as "AI is not configured" — the product never fakes AI output (D-19). */
export class AiNotConfiguredError extends Error {
  constructor(detail: string) {
    super(`AI is not configured: ${detail}`);
    this.name = "AiNotConfiguredError";
  }
}

/**
 * A provider failure worth retrying (429, 5xx, timeouts, dropped connections). The executor
 * retries these with backoff and jitter (D-74); every other provider error fails the run at once.
 */
export class AiTransientError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`AI provider unavailable (${code}): ${detail}`);
    this.name = "AiTransientError";
  }
}

/** A provider failure that will not clear by retrying (bad request, auth, permission). */
export class AiProviderError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`AI provider error (${code}): ${detail}`);
    this.name = "AiProviderError";
  }
}
