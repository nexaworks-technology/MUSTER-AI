import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { logger } from "@/lib/logger";
import {
  AiNotConfiguredError,
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

export function createAnthropicProvider(
  config: AnthropicConfig,
  client = new Anthropic({ apiKey: config.apiKey }),
): AiProvider {
  return {
    name: "anthropic",
    async generateStructured<T>(request: StructuredRequest<T>) {
      const model = config.models[request.tier];
      if (!model) throw new AiNotConfiguredError(`no model set for the "${request.tier}" tier`);
      const started = Date.now();
      const response = await client.messages.parse({
        model,
        max_tokens: request.maxTokens ?? 16_000,
        system: request.system,
        messages: [{ role: "user", content: request.input }],
        output_config: { format: zodOutputFormat(request.schema) },
      });
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
