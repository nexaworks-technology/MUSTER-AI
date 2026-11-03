import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { logger } from "@/lib/logger";
import {
  AiNotConfiguredError,
  AiProviderError,
  AiTransientError,
  type AiProvider,
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

export function createAnthropicProvider(
  config: AnthropicConfig,
  client = new Anthropic({ apiKey: config.apiKey, timeout: AI_REQUEST_TIMEOUT_MS, maxRetries: 0 }),
): AiProvider {
  return {
    name: "anthropic",
    async generateStructured<T>(request: StructuredRequest<T>) {
      const model = config.models[request.tier];
      if (!model) throw new AiNotConfiguredError(`no model set for the "${request.tier}" tier`);
      const started = Date.now();
      let response;
      try {
        response = await client.messages.parse({
          model,
          max_tokens: request.maxTokens ?? 16_000,
          system: request.system,
          messages: [{ role: "user", content: request.input }],
          output_config: { format: zodOutputFormat(request.schema) },
        });
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
          latencyMs,
          valid: result.output !== null,
        },
        "ai call",
      );
      return result;
    },
  };
}
