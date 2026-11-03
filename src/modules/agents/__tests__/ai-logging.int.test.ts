import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AiProvider } from "@/lib/ai";
import { logger } from "@/lib/logger";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { defineAgent } from "../define";
import { runAgent } from "../executor";
import { baseAgentOutput } from "../schemas";

/**
 * Rules 8 and 9 (M4 acceptance #14): an agent run logs ids, statuses and counts, never the prompt,
 * the records it read or what the model wrote. Every logger call made during a run is captured
 * and searched for the content.
 */
const SECRET_TEXT = "Maya told us confidentially that the board will cut the budget";
const MODEL_TEXT = "The champion's budget is about to be cut";

afterEach(() => vi.restoreAllMocks());

describe("agent runs log no AI content", () => {
  it("neither the input records nor the model output appear in any log line", async () => {
    const lines: unknown[] = [];
    for (const level of ["info", "warn", "error", "debug"] as const)
      vi.spyOn(logger, level).mockImplementation(
        ((...args: unknown[]) => void lines.push(args)) as never,
      );
    const { actor } = await createTestAdmin("AiLogging");
    const account = await scopedDb(actor).account.create({
      data: { workspaceId: actor.workspaceId, name: "Brightwell", tier: "HIGH_TOUCH" },
    });
    const provider: AiProvider = {
      name: "recorded",
      async generateStructured<T>() {
        return {
          output: {
            reasoningSummary: MODEL_TEXT,
            confidence: 0.5,
            citations: [
              { sourceType: "Account", sourceId: account.id, quote: "board will cut the budget" },
            ],
            proposedActions: [],
          } as T,
          stopReason: "end_turn",
          model: "model-from-env",
          requestId: "req_1",
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        };
      },
    };
    const agent = defineAgent({
      key: "test-agent",
      version: "1.0.0",
      description: "d",
      modelTier: "standard",
      tierReason: "t",
      prompt: { name: "test-agent", version: "1.0.0" },
      inputSchema: z.object({}),
      outputSchema: baseAgentOutput,
      buildContext: async () => ({
        accountId: account.id,
        bundle: [{ sourceType: "Account", sourceId: account.id, fields: { note: SECRET_TEXT } }],
        vars: { accountName: "Brightwell" },
      }),
      forbiddenNumericFields: [],
      approvalPolicy: "INTERNAL",
    });
    const out = await runAgent(
      actor,
      agent,
      {},
      { type: "t", id: "log" },
      { provider, promptsDir: path.join(import.meta.dirname, "fixtures/prompts") },
    );
    expect(out).toMatchObject({ status: "SUCCEEDED" });
    expect(lines.length).toBeGreaterThan(0); // the run did log (ids and status)
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain("confidentially");
    expect(logged).not.toContain("budget");
    expect(logged).not.toContain("champion");
  });
});
