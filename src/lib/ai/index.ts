import path from "node:path";
import { env } from "@/lib/config/env";
import { createAnthropicProvider } from "./anthropic";
import { createRecordedProvider } from "./recorded";
import { AiNotConfiguredError, type AiProvider } from "./types";

/**
 * The only module that talks to a model provider (ARCHITECTURE §7.8). Each call carries only the
 * current workspace's data. Without ANTHROPIC_API_KEY the product says "AI is not configured".
 */
export * from "./types";
export { loadPrompt, renderPrompt, PromptError } from "./prompts";

export function isAiConfigured(): boolean {
  const e = env();
  return e.AI_PROVIDER === "recorded" || Boolean(e.ANTHROPIC_API_KEY);
}

let provider: AiProvider | undefined;

export function getAiProvider(): AiProvider {
  if (provider) return provider;
  const e = env();
  if (e.AI_PROVIDER === "recorded") {
    provider = createRecordedProvider(
      e.AI_RECORDINGS_DIR
        ? path.resolve(e.AI_RECORDINGS_DIR)
        : path.join(process.cwd(), "prompts", "__recordings__"),
      e.NODE_ENV,
    );
    return provider;
  }
  if (!e.ANTHROPIC_API_KEY) throw new AiNotConfiguredError("ANTHROPIC_API_KEY is not set");
  provider = createAnthropicProvider({
    apiKey: e.ANTHROPIC_API_KEY,
    models: { fast: e.AI_MODEL_FAST, standard: e.AI_MODEL_STANDARD, deep: e.AI_MODEL_DEEP },
  });
  return provider;
}
