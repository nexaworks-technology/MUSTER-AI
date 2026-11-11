import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AiProvider, StructuredRequest, StructuredResult } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { defineAgent } from "../define";
import { budgetStatus, ESSENTIAL_AI_JOBS, noteBudgetUsage } from "../budget";
import { runAgent } from "../executor";
import { baseAgentOutput } from "../schemas";

/**
 * AI cost session item 5: a monthly token budget per workspace with a labelled cost estimate,
 * a soft alert at 80 %, non-essential jobs paused at 100 %, and Ask AI that keeps working.
 */
const PROMPTS = path.join(import.meta.dirname, "fixtures/prompts");
const clock = () => new Date("2026-11-20T12:00:00Z"); // the test workspace's zone is UTC

async function setup(label: string, monthlyTokenBudget: number) {
  const { actor, workspace } = await createTestAdmin(label);
  const db = scopedDb(actor);
  await db.workspaceSettings.upsert({
    where: { workspaceId: actor.workspaceId },
    create: { workspaceId: actor.workspaceId, data: { ai: { monthlyTokenBudget } } },
    update: { data: { ai: { monthlyTokenBudget } } },
  });
  const account = await db.account.create({
    data: { workspaceId: actor.workspaceId, name: `${label} Co`, tier: "HIGH_TOUCH" },
  });
  const spend = (
    tokens: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      planningInputTokens?: number;
      planningOutputTokens?: number;
    },
    over: { createdAt?: Date; modelTier?: string; batchId?: string | null } = {},
  ) =>
    db.agentRun.create({
      data: {
        workspaceId: actor.workspaceId,
        agentKey: "watcher",
        agentVersion: "1",
        promptName: "x",
        modelTier: over.modelTier ?? "fast",
        triggerType: "t",
        triggerId: Math.random().toString(36),
        idempotencyKey: Math.random().toString(36),
        status: "SUCCEEDED",
        // A SUCCEEDED run carries its full audit record (DB check agentrun_succeeded_complete).
        promptVersion: "1.0.0",
        model: "m",
        output: {},
        reasoningSummary: "seeded spend",
        confidence: 0.5,
        batchId: over.batchId ?? null,
        createdAt: over.createdAt ?? new Date("2026-11-10T00:00:00Z"),
        ...tokens,
      },
    });
  return { actor, workspace, db, account, spend };
}

describe("monthly budget status and the cost estimate", () => {
  it("counts this calendar month's tokens (all kinds) against the budget, and estimates the cost", async () => {
    const s = await setup("BudStatus", 1_000_000);
    await s.spend({ inputTokens: 300_000, outputTokens: 100_000 }); // fast: 0.3 + 0.5 = $0.80
    await s.spend(
      { inputTokens: 100_000, cacheReadTokens: 100_000, outputTokens: 0 },
      { modelTier: "deep" },
    ); // 0.3 + 0.03
    await s.spend({ inputTokens: 1_000_000 }, { createdAt: new Date("2026-10-31T23:00:00Z") }); // last month
    const st = await budgetStatus(s.actor, clock);
    expect(st.month).toBe("2026-11");
    expect(st.usedTokens).toBe(300_000 + 100_000 + 100_000 + 100_000);
    expect(st.budgetTokens).toBe(1_000_000);
    expect(st.percent).toBeCloseTo(60, 6);
    expect(st.level).toBe("OK");
    expect(st.runs).toBe(2);
    expect(st.estimatedCostUsd).toBeCloseTo(0.8 + 0.33, 6);
    expect(st.byTier.map((t) => t.tier).sort()).toEqual(["deep", "fast"]);
  });

  it("counts Ask AI's planning tokens, and prices them at the fast tier", async () => {
    const s = await setup("BudPlanning", 10_000_000);
    // A deep-tier Ask AI answer: 100k answer input tokens plus 1M planning input tokens.
    await s.spend({ inputTokens: 100_000, planningInputTokens: 1_000_000 }, { modelTier: "deep" });
    const st = await budgetStatus(s.actor, clock);
    expect(st.usedTokens).toBe(1_100_000);
    expect(st.estimatedCostUsd).toBeCloseTo(0.3 + 1.0, 6); // $3/M answer + $1/M planning
  });

  it("prices batched runs at half", async () => {
    const s = await setup("BudBatch", 1_000_000);
    await s.spend({ inputTokens: 1_000_000 }, { batchId: "msgbatch_1" });
    const st = await budgetStatus(s.actor, clock);
    expect(st.estimatedCostUsd).toBeCloseTo(0.5, 6);
    expect(st.batchedRuns).toBe(1);
  });

  it("reports OK below 80 %, SOFT from 80 %, PAUSED from 100 %", async () => {
    const levels = [];
    for (const used of [799_999, 800_000, 999_999, 1_000_000]) {
      const s = await setup(`BudLevel${used}`, 1_000_000);
      await s.spend({ inputTokens: used });
      levels.push((await budgetStatus(s.actor, clock)).level);
    }
    expect(levels).toEqual(["OK", "SOFT", "SOFT", "PAUSED"]);
  });
});

describe("the 80 % soft alert", () => {
  it("tells each Admin and CS Leader once per month, and not below 80 %", async () => {
    const s = await setup("BudAlert", 1_000_000);
    await noteBudgetUsage(s.actor, clock);
    expect(await s.db.notification.count()).toBe(0);

    await s.spend({ inputTokens: 850_000 });
    await noteBudgetUsage(s.actor, clock);
    await noteBudgetUsage(s.actor, clock); // a second pass in the same month adds nothing
    const notes = await s.db.notification.findMany();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      type: "AI_BUDGET_SOFT",
      recipientMembershipId: s.actor.membershipId,
      refType: "AiBudget",
      refId: "2026-11",
    });
    expect(notes[0]!.title).toMatch(/85 %/);
    expect(notes[0]!.title).toMatch(/estimate/i);

    // The next month alerts again.
    await s.spend({ inputTokens: 900_000 }, { createdAt: new Date("2026-12-02T00:00:00Z") });
    await noteBudgetUsage(s.actor, () => new Date("2026-12-05T12:00:00Z"));
    expect(await s.db.notification.count()).toBe(2);
  });
});

const output = z.object({ ...baseAgentOutput.shape });
const fake = (): { provider: AiProvider; calls: number[] } => {
  const calls: number[] = [];
  return {
    calls,
    provider: {
      name: "recorded",
      async generateStructured<T>(request: StructuredRequest<T>) {
        calls.push(1);
        const id = /"sourceId": "([^"]+)"/.exec(request.input)![1]!;
        return {
          output: {
            reasoningSummary: "ok",
            confidence: 0.9,
            citations: [{ sourceType: "Account", sourceId: id, quote: "36 of 207 seats" }],
            proposedActions: [],
          } as T,
          stopReason: "end_turn",
          model: "m",
          requestId: null,
          inputTokens: 10,
          outputTokens: 5,
          latencyMs: 1,
        } as StructuredResult<T>;
      },
    },
  };
};

const agentNamed = (key: string) =>
  defineAgent({
    key,
    version: "1.0.0",
    description: "test",
    modelTier: "fast",
    tierReason: "test",
    prompt: { name: "test-agent", version: "1.0.0" },
    inputSchema: z.object({ accountId: z.string() }),
    outputSchema: output,
    async buildContext(sdb, input: { accountId: string }) {
      const a = await sdb.account.findUnique({ where: { id: input.accountId } });
      return {
        accountId: a?.id,
        vars: { accountName: a?.name ?? "unknown" },
        bundle: a
          ? [
              {
                sourceType: "Account",
                sourceId: a.id,
                fields: { name: a.name, seats: "36 of 207 seats" },
              },
            ]
          : [],
      };
    },
    forbiddenNumericFields: ["confidence"],
    approvalPolicy: "INTERNAL",
  });

describe("at 100 %, non-essential jobs pause and Ask AI keeps working", () => {
  it("Ask AI is the only essential job", () => {
    expect([...ESSENTIAL_AI_JOBS]).toEqual(["ask-ai"]);
  });

  it("skips a non-essential agent with a monthly-budget reason, makes no model call, and still runs ask-ai", async () => {
    const s = await setup("BudPause", 1_000);
    await s.spend({ inputTokens: 1_000 });
    const { provider, calls } = fake();
    const deps = { provider, promptsDir: PROMPTS, clock };

    const paused = await runAgent(
      s.actor,
      agentNamed("watcher"),
      { accountId: s.account.id },
      { type: "t", id: "1" },
      deps,
    );
    expect(paused).toMatchObject({ kind: "run", status: "SKIPPED" });
    expect(calls).toHaveLength(0);
    const row = await s.db.agentRun.findFirstOrThrow({
      where: { agentKey: "watcher", triggerId: "1" },
    });
    expect(row).toMatchObject({ status: "SKIPPED", errorCode: "MONTHLY_BUDGET" });
    expect(row.errorDetail).toMatch(/monthly/i);

    const ask = await runAgent(
      s.actor,
      agentNamed("ask-ai"),
      { accountId: s.account.id },
      { type: "t", id: "2" },
      deps,
    );
    expect(ask).toMatchObject({ kind: "run", status: "SUCCEEDED" });
    expect(calls).toHaveLength(1);
  });

  it("an unset month with room left runs everything normally", async () => {
    const s = await setup("BudRoom", 1_000_000);
    const { provider, calls } = fake();
    const out = await runAgent(
      s.actor,
      agentNamed("watcher"),
      { accountId: s.account.id },
      { type: "t", id: "1" },
      { provider, promptsDir: PROMPTS, clock },
    );
    expect(out).toMatchObject({ kind: "run", status: "SUCCEEDED" });
    expect(calls).toHaveLength(1);
  });
});
