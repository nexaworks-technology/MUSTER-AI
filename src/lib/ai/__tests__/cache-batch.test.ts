import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAnthropicProvider } from "../anthropic";
import { createRecordedProvider } from "../recorded";
import { AiNotConfiguredError, type BatchRequest, type StructuredRequest } from "../types";

const schema = z.object({ summary: z.string() });
const request: StructuredRequest<z.infer<typeof schema>> = {
  tier: "fast",
  workspaceId: "ws_1",
  promptRef: "example-agent@1.0.0",
  system: "stable system text",
  input: "per-account records",
  schema,
};
const models = { fast: "haiku-from-env", deep: "sonnet-from-env" };

const usage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 4000,
  cache_creation_input_tokens: 0,
};

function fakeClient(over: {
  parse?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
  retrieve?: ReturnType<typeof vi.fn>;
  results?: ReturnType<typeof vi.fn>;
}) {
  return {
    messages: {
      parse: over.parse ?? vi.fn(),
      batches: {
        create: over.create ?? vi.fn(),
        retrieve: over.retrieve ?? vi.fn(),
        results: over.results ?? vi.fn(),
      },
    },
  } as unknown as Anthropic;
}

describe("prompt caching (docs/AI-COST-2026-11-11.md, item 3)", () => {
  it("sends the system prompt as a cache-marked block, and not the per-call records", async () => {
    const parse = vi.fn(async () => ({
      parsed_output: { summary: "ok" },
      stop_reason: "end_turn",
      model: "haiku-from-env",
      _request_id: "r",
      usage,
    }));
    const provider = createAnthropicProvider({ apiKey: "k", models }, fakeClient({ parse }));
    await provider.generateStructured(request);
    const params = (parse.mock.calls[0] as unknown[])[0] as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(params.system).toEqual([
      { type: "text", text: "stable system text", cache_control: { type: "ephemeral" } },
    ]);
    // Per-call content is unique, so marking it would only add the cache-write surcharge.
    expect(params.messages).toEqual([{ role: "user", content: "per-account records" }]);
  });

  it("returns cache-read and cache-write token counts from the provider's usage", async () => {
    const parse = vi.fn(async () => ({
      parsed_output: { summary: "ok" },
      stop_reason: "end_turn",
      model: "haiku-from-env",
      usage: { ...usage, cache_creation_input_tokens: 7 },
    }));
    const provider = createAnthropicProvider({ apiKey: "k", models }, fakeClient({ parse }));
    const r = await provider.generateStructured(request);
    expect(r).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 4000,
      cacheCreationTokens: 7,
    });
  });

  it("treats absent cache counters as zero", async () => {
    const parse = vi.fn(async () => ({
      parsed_output: { summary: "ok" },
      stop_reason: "end_turn",
      model: "m",
      usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: null },
    }));
    const provider = createAnthropicProvider({ apiKey: "k", models }, fakeClient({ parse }));
    expect(await provider.generateStructured(request)).toMatchObject({
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

const batchRequests: BatchRequest[] = [
  { ...request, customId: "run_a" },
  { ...request, tier: "deep", customId: "run_b", input: "other" },
];

describe("Message Batches (item 2)", () => {
  it("submits every request in ONE batch call, with the tier's model and the cache marker", async () => {
    const create = vi.fn(async () => ({ id: "msgbatch_1", processing_status: "in_progress" }));
    const provider = createAnthropicProvider({ apiKey: "k", models }, fakeClient({ create }));
    const { batchId } = await provider.submitBatch!(batchRequests);
    expect(batchId).toBe("msgbatch_1");
    expect(create).toHaveBeenCalledTimes(1);
    const body = (create.mock.calls[0] as unknown[])[0] as {
      requests: Array<{ custom_id: string; params: Record<string, unknown> }>;
    };
    expect(body.requests.map((r) => r.custom_id)).toEqual(["run_a", "run_b"]);
    expect(body.requests.map((r) => r.params.model)).toEqual(["haiku-from-env", "sonnet-from-env"]);
    for (const r of body.requests) {
      expect(r.params).toHaveProperty("output_config.format");
      expect(r.params.system).toEqual([
        { type: "text", text: "stable system text", cache_control: { type: "ephemeral" } },
      ]);
    }
  });

  it("refuses to submit when a tier has no model configured", async () => {
    const provider = createAnthropicProvider(
      { apiKey: "k", models: { fast: "haiku-from-env" } },
      fakeClient({}),
    );
    await expect(provider.submitBatch!(batchRequests)).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  it("reports an unfinished batch as not done, without reading results", async () => {
    const retrieve = vi.fn(async () => ({ id: "b", processing_status: "in_progress" }));
    const results = vi.fn();
    const provider = createAnthropicProvider(
      { apiKey: "k", models },
      fakeClient({ retrieve, results }),
    );
    expect(await provider.getBatch!("b")).toEqual({ done: false, items: [] });
    expect(results).not.toHaveBeenCalled();
  });

  it("returns each finished request's text and token usage, and each failure's reason", async () => {
    const retrieve = vi.fn(async () => ({ id: "b", processing_status: "ended" }));
    async function* stream() {
      yield {
        custom_id: "run_a",
        result: {
          type: "succeeded",
          message: {
            content: [{ type: "text", text: '{"summary":"hi"}' }],
            stop_reason: "end_turn",
            model: "haiku-from-env",
            id: "msg_1",
            usage,
          },
        },
      };
      yield {
        custom_id: "run_b",
        result: { type: "errored", error: { type: "error", error: { type: "overloaded_error" } } },
      };
      yield { custom_id: "run_c", result: { type: "expired" } };
      yield { custom_id: "run_d", result: { type: "canceled" } };
    }
    const results = vi.fn(async () => stream());
    const provider = createAnthropicProvider(
      { apiKey: "k", models },
      fakeClient({ retrieve, results }),
    );
    const out = await provider.getBatch!("b");
    expect(out.done).toBe(true);
    expect(out.items).toEqual([
      {
        customId: "run_a",
        outcome: "succeeded",
        text: '{"summary":"hi"}',
        stopReason: "end_turn",
        model: "haiku-from-env",
        requestId: "msg_1",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 4000,
        cacheCreationTokens: 0,
      },
      {
        customId: "run_b",
        outcome: "errored",
        code: "overloaded_error",
        detail: expect.any(String),
      },
      { customId: "run_c", outcome: "expired", code: "expired", detail: expect.any(String) },
      { customId: "run_d", outcome: "canceled", code: "canceled", detail: expect.any(String) },
    ]);
  });
});

describe("recorded provider batches (tests and demos)", () => {
  it("answers a batch from its recordings, finished at once, as the same item shape", async () => {
    const provider = createRecordedProvider("/nonexistent", "test");
    const { batchId } = await provider.submitBatch!([{ ...request, customId: "x" }]);
    const out = await provider.getBatch!(batchId);
    // No recording exists in that directory, so the item fails loudly rather than inventing text.
    expect(out.done).toBe(true);
    expect(out.items[0]).toMatchObject({ customId: "x", outcome: "errored" });
  });
});
