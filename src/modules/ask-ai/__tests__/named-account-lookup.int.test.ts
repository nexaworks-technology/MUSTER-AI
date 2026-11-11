import { randomUUID } from "node:crypto";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { constrainToSchema } from "@/test/constrain-schema";
import { createTestAdmin } from "@/test/fixtures";
import { PLAN_OUTPUT } from "../loop";
import { askQuestion, getThread } from "../service";
import { ASK_TOOLS, runAskTool } from "../tools";

/**
 * Regression (docs/AI-COST-2026-11-11.md, "Ask AI could not look up a named account"): in the dev
 * workspace Ask AI said Northgate Freight does not exist, on Haiku and on Sonnet, though the account
 * has a $142,000 contract. Cause: the schema sent to the model declared each tool call's `input` as
 * a closed empty object, so constrained decoding could only produce `{}`. Every `searchAccounts`
 * listed the first 25 accounts and never found it; every `getContract` had no accountId. The fake
 * provider the older tests use skips that schema, so nothing caught it. This provider is
 * constrained to the schema exactly as the live API is.
 */
type PlanReq = {
  step: number;
  results: Array<{
    tool: string;
    records: Array<{ ref: string; label: string; type: string; id: string }>;
    notFound: string | null;
    note?: string | null;
  }>;
};

const planCalls: PlanReq[] = [];

/** A planner that behaves like a sensible model: search by name, then read the account's contract. */
function constrainedProvider(): AiProvider {
  return {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      let output: unknown;
      if (req.promptRef.startsWith("ask-ai-plan@")) {
        const p = JSON.parse(req.input) as PlanReq;
        planCalls.push(p);
        const seen = p.results.flatMap((r) => r.records);
        const northgate = seen.find(
          (r) => r.ref.startsWith("Account:") && /Northgate/.test(r.label),
        );
        const contract = seen.find((r) => r.ref.startsWith("Contract:"));
        if (p.step === 1)
          output = {
            action: "call",
            calls: [{ tool: "searchAccounts", input: { query: "Northgate Freight" } }],
          };
        else if (northgate && !contract)
          output = {
            action: "call",
            calls: [
              { tool: "getContract", input: { accountId: northgate.ref.slice("Account:".length) } },
            ],
          };
        else output = { action: "answer" };
        // Constrained decoding: the model can only say what the schema allows it to say.
        output = constrainToSchema(
          output,
          zodOutputFormat(req.schema as z.ZodType).schema as never,
        );
      } else {
        const bundle = JSON.parse(req.input.slice(req.input.indexOf("["))) as Array<{
          sourceType: string;
          sourceId: string;
        }>;
        const c = bundle.find((r) => r.sourceType === "Contract");
        const a = bundle.find((r) => r.sourceType === "Account");
        output = c
          ? {
              reasoningSummary: "Read the account and its contract.",
              confidence: 0.8,
              proposedActions: [],
              answer: "Northgate Freight's contract is worth $142,000.",
              citations: [
                { sourceType: "Contract", sourceId: c.sourceId },
                ...(a ? [{ sourceType: "Account", sourceId: a.sourceId }] : []),
              ],
              figures: [
                {
                  value: "142000.00",
                  sourceType: "Contract",
                  sourceId: c.sourceId,
                  field: "value",
                },
              ],
            }
          : {
              reasoningSummary: "Nothing found.",
              confidence: 0.3,
              proposedActions: [],
              answer: "I could not find that account in the records I can see.",
              citations: [],
              figures: [],
            };
      }
      return {
        output: req.schema.parse(output) as T,
        stopReason: "end_turn",
        model: "test-model",
        requestId: randomUUID(),
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 1,
      };
    },
  };
}

async function workspaceWith(accounts: number) {
  const { actor, workspace } = await createTestAdmin("NamedLookup");
  const db = scopedDb(actor);
  // "Acme 01…" sort before "Northgate", so an empty search's first 25 rows never include it.
  for (let i = 1; i <= accounts; i++)
    await db.account.create({
      data: {
        workspaceId: workspace.id,
        name: `Acme ${String(i).padStart(2, "0")}`,
        tier: "MID_TOUCH",
      },
    });
  const northgate = await db.account.create({
    data: { workspaceId: workspace.id, name: "Northgate Freight", tier: "HIGH_TOUCH" },
  });
  await db.contract.create({
    data: {
      workspaceId: workspace.id,
      accountId: northgate.id,
      startDate: new Date("2026-01-01"),
      renewalDate: new Date("2026-12-15"),
      valueMinor: 14_200_000n,
      currency: "USD",
      noticePeriodDays: 60,
    },
  });
  return { actor, db, northgate };
}

describe("named-account questions find the account (FIX: lookup path)", () => {
  it("a question naming an account that exists returns its facts with citations, in a workspace of 31 accounts", async () => {
    const w = await workspaceWith(30);
    planCalls.length = 0;
    const res = await askQuestion(
      { ...w.actor, bookScope: w.actor.bookScope },
      { question: "What is Northgate Freight's contract value?" },
      { provider: constrainedProvider() },
    );
    expect(res.status).toBe("SUCCEEDED");
    const { messages } = await getThread(w.actor, res.threadId);
    const answer = messages.find((m) => m.role === "ASSISTANT")!;
    expect(answer.content).toContain("142,000");
    const cites = JSON.stringify(answer.citations);
    expect(cites).toContain("Contract for Northgate Freight");
    expect(cites).toContain("Northgate Freight");
    // The planner's arguments reached the tools: the search carried the name, the contract lookup
    // carried the account id found by that search.
    const run = await w.db.agentRun.findUniqueOrThrow({ where: { id: res.runId! } });
    expect(JSON.stringify(run.inputRefs)).toContain(w.northgate.id);
    const steps = (
      answer.toolCalls as { steps: Array<{ tool: string; input: Record<string, unknown> }> }
    ).steps;
    expect(steps[0]).toEqual({ tool: "searchAccounts", input: { query: "Northgate Freight" } });
    expect(steps[1]).toEqual({ tool: "getContract", input: { accountId: w.northgate.id } });
  });

  it("an id passed the way results label it ('Account:<id>') still finds the account and its contract", async () => {
    // Live, the planner copies the `ref` it was shown ("Account:<id>") into accountId.
    const w = await workspaceWith(2);
    const bare = await runAskTool(w.actor, "getContract", { accountId: w.northgate.id });
    const prefixed = await runAskTool(w.actor, "getContract", {
      accountId: `Account:${w.northgate.id}`,
    });
    expect(bare.records).toHaveLength(1);
    expect(prefixed.records.map((r) => r.id)).toEqual(bare.records.map((r) => r.id));
    expect(prefixed.notFound).toBeNull();
    // An id that matches nothing still says so plainly (it is not silently "found").
    const wrong = await runAskTool(w.actor, "getContract", { accountId: "Account:nope" });
    expect(wrong.records).toEqual([]);
    expect(wrong.notFound).toMatch(/cannot see an account/i);
  });

  it("the schema sent to the model lets every tool argument through (a new argument cannot be dropped silently)", () => {
    const sent = zodOutputFormat(PLAN_OUTPUT).schema as unknown as {
      $defs: Record<
        string,
        {
          properties: {
            input: { properties: Record<string, unknown>; additionalProperties: unknown };
          };
        }
      >;
    };
    const input = Object.values(sent.$defs)[0]!.properties.input;
    expect(Object.keys(input.properties).length).toBeGreaterThan(0);
    for (const t of ASK_TOOLS) {
      const args = Object.keys(
        (z.toJSONSchema(t.input) as { properties?: Record<string, unknown> }).properties ?? {},
      );
      for (const a of args)
        expect(
          input.properties,
          `tool ${t.name} argument "${a}" is not in the plan schema`,
        ).toHaveProperty(a);
    }
  });

  it("a search cut off at 25 says so, so a list that does not show the account is never read as 'not there'", async () => {
    const w = await workspaceWith(30);
    const out = await runAskTool(w.actor, "searchAccounts", {});
    expect(out.records).toHaveLength(25);
    expect(out.notFound).toBeNull();
    expect(out.note).toMatch(/first 25 of 31/);
    expect(out.note).toMatch(/not the full list/i);
    // A search that names the account is not cut off and carries no note.
    const named = await runAskTool(w.actor, "searchAccounts", { query: "Northgate" });
    expect(named.records.map((r) => r.label)).toEqual(["Northgate Freight"]);
    expect(named.note ?? null).toBeNull();
  });
});
