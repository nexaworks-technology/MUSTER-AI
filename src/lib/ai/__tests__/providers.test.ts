import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAnthropicProvider } from "../anthropic";
import { createRecordedProvider, recordingKey } from "../recorded";
import { AiNotConfiguredError, type StructuredRequest } from "../types";

const schema = z.object({ summary: z.string() });
const request: StructuredRequest<z.infer<typeof schema>> = {
  tier: "standard",
  workspaceId: "ws_1",
  promptRef: "example-agent@1.0.0",
  system: "system text",
  input: "customer said something private",
  schema,
};

/** A stand-in for the SDK client: only messages.parse is used by the provider. */
function fakeClient(response: Record<string, unknown>) {
  const parse = vi.fn(async () => response);
  return { client: { messages: { parse } } as unknown as Anthropic, parse };
}

describe("Anthropic provider", () => {
  it("uses the model configured for the tier and returns the parsed output", async () => {
    const { client, parse } = fakeClient({
      parsed_output: { summary: "ok" },
      stop_reason: "end_turn",
      model: "model-from-env",
      _request_id: "req_1",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = createAnthropicProvider(
      { apiKey: "k", models: { standard: "model-from-env" } },
      client,
    );
    const result = await provider.generateStructured(request);
    expect(result).toMatchObject({
      output: { summary: "ok" },
      requestId: "req_1",
      inputTokens: 10,
      outputTokens: 5,
    });
    const params = (parse.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(params.model).toBe("model-from-env");
    expect(params).toHaveProperty("output_config.format");
    expect(params).not.toHaveProperty("tool_choice");
  });

  it("returns no output when the model declines", async () => {
    const { client } = fakeClient({
      parsed_output: null,
      stop_reason: "refusal",
      model: "m",
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    const provider = createAnthropicProvider({ apiKey: "k", models: { standard: "m" } }, client);
    expect((await provider.generateStructured(request)).output).toBeNull();
  });

  it("refuses a tier with no model configured", async () => {
    const { client } = fakeClient({});
    const provider = createAnthropicProvider({ apiKey: "k", models: {} }, client);
    await expect(provider.generateStructured(request)).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
});

describe("recorded provider (D-19)", () => {
  it("is refused in production", () => {
    expect(() => createRecordedProvider("/tmp", "production")).toThrow(/refused in production/);
  });

  it("replays a recording and validates it with the same schema", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rec-"));
    await mkdir(path.join(dir, "example-agent"));
    await writeFile(
      path.join(dir, "example-agent", `${recordingKey(request)}.json`),
      JSON.stringify({ summary: "recorded" }),
    );
    const provider = createRecordedProvider(dir, "test");
    expect((await provider.generateStructured(request)).output).toEqual({ summary: "recorded" });
  });

  it("fails loudly when no recording exists instead of inventing output", async () => {
    const provider = createRecordedProvider(await mkdtemp(path.join(tmpdir(), "rec-")), "test");
    await expect(provider.generateStructured(request)).rejects.toThrow(/no recording/);
  });
});
