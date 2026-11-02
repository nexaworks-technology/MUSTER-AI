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
}

export interface StructuredResult<T> {
  /** Null when the model declined or its output failed validation — never guessed. */
  output: T | null;
  stopReason: string | null;
  model: string;
  requestId: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface AiProvider {
  readonly name: "anthropic" | "recorded";
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

/** Shown in the UI as "AI is not configured" — the product never fakes AI output (D-19). */
export class AiNotConfiguredError extends Error {
  constructor(detail: string) {
    super(`AI is not configured: ${detail}`);
    this.name = "AiNotConfiguredError";
  }
}
