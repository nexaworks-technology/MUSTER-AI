import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { logger } from "@/lib/logger";
import {
  AiNotConfiguredError,
  AiProviderError,
  AiTransientError,
  type AiProvider,
  type BatchItem,
  type BatchRequest,
  type ModelTier,
  type StructuredRequest,
} from "./types";

/**
 * Anthropic implementation. Structured output uses the Messages API's `output_config.format`
 * (via `messages.parse` + zodOutputFormat); forced tool_choice is rejected by current models.
 * Logs ids, token counts and latency only — never prompt or response content (Rule 8/9).
 */
export interface AnthropicConfig {
  apiKey: string;
  models: Partial<Record<ModelTier, string>>;
}

/** Per-request timeout; the SDK's own retries are off because the executor owns retries (D-74). */
export const AI_REQUEST_TIMEOUT_MS = 60_000;

/** Maps an SDK error to transient (retry) or permanent (fail now). Messages carry no content. */
export function classifyProviderError(error: unknown): Error {
  if (error instanceof Anthropic.APIConnectionTimeoutError)
    return new AiTransientError("timeout", "the request timed out");
  if (error instanceof Anthropic.APIConnectionError)
    return new AiTransientError("connection", "the connection failed");
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    if (status === 429 || status === 529 || status >= 500)
      return new AiTransientError(`http_${status}`, "the provider is busy or failing");
    return new AiProviderError(`http_${status}`, "the provider refused the request");
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The Messages API parameters for one request, shared by real-time calls and batch entries.
 * Prompt caching (docs/AI-COST-2026-11-11.md): the system prompt carries the cache marker. It is
 * the part that repeats (retries, the repair call, every step of Ask AI's loop, batch entries).
 * The per-call records are NOT marked: they are unique, and a cache write costs 1.25× input, so
 * marking them would add a surcharge and never be read. A prefix under the model's minimum
 * cacheable length (4,096 tokens on Haiku 4.5) is simply not cached; the marker is then inert.
 */
export function messageParams<T>(model: string, request: StructuredRequest<T>) {
  return {
    model,
    max_tokens: request.maxTokens ?? 16_000,
    system: [
      {
        type: "text" as const,
        text: request.system,
        cache_control: { type: "ephemeral" as const },
      },
    ],
    messages: [{ role: "user" as const, content: request.input }],
    output_config: { format: zodOutputFormat(request.schema) },
  };
}

const modelFor = (config: AnthropicConfig, tier: ModelTier): string => {
  const model = config.models[tier];
  if (!model) throw new AiNotConfiguredError(`no model set for the "${tier}" tier`);
  return model;
};

/** A batch result's error as a short code; messages carry no content (Rule 8/9). */
const batchErrorCode = (error: unknown): string => {
  const inner = (error as { error?: { error?: { type?: string }; type?: string } } | null)?.error;
  return inner?.error?.type ?? inner?.type ?? "error";
};

export function createAnthropicProvider(
  config: AnthropicConfig,
  client = new Anthropic({ apiKey: config.apiKey, timeout: AI_REQUEST_TIMEOUT_MS, maxRetries: 0 }),
): AiProvider {
  return {
    name: "anthropic",
    async generateStructured<T>(request: StructuredRequest<T>) {
      const model = modelFor(config, request.tier);
      const started = Date.now();
      let response;
      try {
        response = await client.messages.parse(
          messageParams(model, request),
          request.timeoutMs ? { timeout: request.timeoutMs } : undefined,
        );
      } catch (error) {
        // The SDK throws (not an APIError) when the output does not match the schema: that is an
        // invalid output for the executor's single repair call, not a provider failure.
        if (
          error instanceof Anthropic.AnthropicError &&
          !(error instanceof Anthropic.APIError) &&
          /Failed to parse structured output/.test(error.message)
        )
          return {
            output: null,
            stopReason: "invalid_output",
            model,
            requestId: null,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: Date.now() - started,
            validationError: error.message.slice(0, 2_000),
          };
        throw classifyProviderError(error);
      }
      const latencyMs = Date.now() - started;
      const result = {
        // parsed_output is null when the model declined or output did not match the schema.
        output:
          response.stop_reason === "refusal"
            ? null
            : ((response.parsed_output as T | null) ?? null),
        stopReason: response.stop_reason,
        model: response.model,
        requestId: response._request_id ?? null,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
        latencyMs,
      };
      logger.info(
        {
          workspaceId: request.workspaceId,
          promptRef: request.promptRef,
          tier: request.tier,
          model: result.model,
          requestId: result.requestId,
          stopReason: result.stopReason,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheCreationTokens: result.cacheCreationTokens,
          latencyMs,
          valid: result.output !== null,
        },
        "ai call",
      );
      return result;
    },

    /** One Message Batches call for every request; results are collected later with `getBatch`. */
    async submitBatch(requests: BatchRequest[]) {
      const entries = requests.map((r) => ({
        custom_id: r.customId,
        params: messageParams(modelFor(config, r.tier), r),
      }));
      try {
        const batch = await client.messages.batches.create({ requests: entries });
        logger.info(
          {
            requests: entries.length,
            batchId: batch.id,
            workspaceIds: [...new Set(requests.map((r) => r.workspaceId))],
          },
          "ai batch submitted",
        );
        return { batchId: batch.id };
      } catch (error) {
        throw classifyProviderError(error);
      }
    },

    async getBatch(batchId: string) {
      let batch;
      try {
        batch = await client.messages.batches.retrieve(batchId);
      } catch (error) {
        throw classifyProviderError(error);
      }
      if (batch.processing_status !== "ended") return { done: false, items: [] };
      const items: BatchItem[] = [];
      try {
        for await (const line of await client.messages.batches.results(batchId)) {
          const r = line.result;
          if (r.type === "succeeded") {
            const text = r.message.content
              .flatMap((b) => (b.type === "text" ? [b.text] : []))
              .join("");
            items.push({
              customId: line.custom_id,
              outcome: "succeeded",
              text: text === "" ? null : text,
              stopReason: r.message.stop_reason,
              model: r.message.model,
              requestId: r.message.id ?? null,
              inputTokens: r.message.usage.input_tokens,
              outputTokens: r.message.usage.output_tokens,
              cacheReadTokens: r.message.usage.cache_read_input_tokens ?? 0,
              cacheCreationTokens: r.message.usage.cache_creation_input_tokens ?? 0,
            });
          } else if (r.type === "errored") {
            items.push({
              customId: line.custom_id,
              outcome: "errored",
              code: batchErrorCode(r.error),
              detail: "the batch request failed",
            });
          } else {
            items.push({
              customId: line.custom_id,
              outcome: r.type,
              code: r.type,
              detail: `the batch request ${r.type} before it was processed`,
            });
          }
        }
      } catch (error) {
        throw classifyProviderError(error);
      }
      return { done: true, items };
    },
  };
}
