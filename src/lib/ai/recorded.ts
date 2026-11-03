import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { AiNotConfiguredError, type AiProvider, type StructuredRequest } from "./types";

/**
 * Test/demo-replay provider (DECISIONS D-19): returns previously recorded model outputs, keyed by
 * prompt and exact input, and validates them with the same schema as live calls. Refused in
 * production. A request with no recording fails loudly — it never invents an answer.
 */
export function recordingKey(
  request: Pick<StructuredRequest<unknown>, "promptRef" | "system" | "input">,
): string {
  return createHash("sha256")
    .update(`${request.promptRef}\n${request.system}\n${request.input}`)
    .digest("hex")
    .slice(0, 32);
}

export function createRecordedProvider(dir: string, nodeEnv = process.env.NODE_ENV): AiProvider {
  if (nodeEnv === "production")
    throw new Error("The recorded AI provider is refused in production (D-19)");
  return {
    name: "recorded",
    async generateStructured<T>(request: StructuredRequest<T>) {
      const promptName = request.promptRef.split("@")[0] ?? request.promptRef;
      const file = path.join(dir, promptName, `${recordingKey(request)}.json`);
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        throw new AiNotConfiguredError(
          `no recording for ${request.promptRef} at ${path.relative(process.cwd(), file)}`,
        );
      }
      const recorded = JSON.parse(raw) as unknown;
      // A recording may stand for a refusal: { "__stopReason": "refusal" } (tests only).
      if (
        recorded !== null &&
        typeof recorded === "object" &&
        (recorded as { __stopReason?: unknown }).__stopReason === "refusal"
      )
        return {
          output: null,
          stopReason: "refusal",
          model: "recorded",
          requestId: null,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 0,
        };
      const parsed = request.schema.safeParse(recorded);
      return {
        output: parsed.success ? parsed.data : null,
        stopReason: parsed.success ? "end_turn" : "invalid_output",
        ...(parsed.success ? {} : { validationError: parsed.error.message.slice(0, 2_000) }),
        model: "recorded",
        requestId: null,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
      };
    },
  };
}
