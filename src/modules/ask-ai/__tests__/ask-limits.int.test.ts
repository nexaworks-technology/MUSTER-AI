import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AiTransientError,
  type AiProvider,
  type StructuredRequest,
  type StructuredResult,
} from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { defineAgent, runAgent } from "@/modules/agents/service";
import { baseAgentOutput } from "@/modules/agents/schemas";
import { askQuestion, ASK_TIMEOUT_MESSAGE } from "../service";

/**
 * FIX-2026-11-11-ASK2 items 3 and 4. Evidence: run cmwc0i8le000nnx0yve1r51sm ended PROVIDER_TIMEOUT
 * at attempt 5 and the UNCITED run reached attempt 4 over 255 s, because a timeout was retried up to
 * five times at 60 s each. A person is waiting on Ask AI: one honest answer, quickly, never a retry
 * loop. One attempt also crashed the page: a planning-step timeout was not caught, so nothing was
 * saved, and a request this long runs into the 100 s limit of the tunnel/proxy in front of the app.
 */
const PROMPTS = path.join(import.meta.dirname, "../../agents/__tests__/fixtures/prompts");
const timeout = () => new AiTransientError("timeout", "the request timed out");
const busy = () => new AiTransientError("http_529", "the provider is busy");

// ── the executor: interactive runs ───────────────────────────────────────────────────────────────
const output = z.object({ ...baseAgentOutput.shape });
const agent = defineAgent({
  key: "test-agent",
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

function flaky(errors: Error[]) {
  const calls: Array<StructuredRequest<unknown>> = [];
  const p: AiProvider = {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      calls.push(req as StructuredRequest<unknown>);
      const next = errors.shift();
      if (next) throw next;
      const id = /"sourceId": "([^"]+)"/.exec(req.input)![1]!;
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
  };
  return { p, calls };
}

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const account = await db.account.create({
    data: { workspaceId: actor.workspaceId, name: `${label} Co`, tier: "MID_TOUCH" },
  });
  return { actor, db, account };
}
const noSleep = async () => {};
const trigger = (id: string) => ({ type: "t", id });

describe("interactive runs: at most two attempts, and a timeout is never retried", () => {
  it("a timeout ends the run at once with PROVIDER_TIMEOUT after ONE call", async () => {
    const s = await setup("LimTimeout");
    const { p, calls } = flaky([timeout(), timeout(), timeout()]);
    const out = await runAgent(s.actor, agent, { accountId: s.account.id }, trigger("a"), {
      provider: p,
      promptsDir: PROMPTS,
      interactive: true,
      sleep: noSleep,
    });
    expect(out).toMatchObject({ kind: "run", status: "FAILED" });
    expect(calls).toHaveLength(1);
    const run = await s.db.agentRun.findFirstOrThrow({ where: { triggerId: "a" } });
    expect(run).toMatchObject({ status: "FAILED", errorCode: "PROVIDER_TIMEOUT", attempt: 1 });
  });

  it("a busy provider (429/529) is retried once, so at most two attempts in all", async () => {
    const s = await setup("LimBusy");
    const once = flaky([busy()]);
    const ok = await runAgent(s.actor, agent, { accountId: s.account.id }, trigger("b1"), {
      provider: once.p,
      promptsDir: PROMPTS,
      interactive: true,
      sleep: noSleep,
    });
    expect(ok).toMatchObject({ status: "SUCCEEDED" });
    expect(once.calls).toHaveLength(2);

    const twice = flaky([busy(), busy(), busy()]);
    const failed = await runAgent(s.actor, agent, { accountId: s.account.id }, trigger("b2"), {
      provider: twice.p,
      promptsDir: PROMPTS,
      interactive: true,
      sleep: noSleep,
    });
    expect(failed).toMatchObject({ status: "FAILED" });
    expect(twice.calls).toHaveLength(2);
    expect((await s.db.agentRun.findFirstOrThrow({ where: { triggerId: "b2" } })).errorCode).toBe(
      "PROVIDER_HTTP_529",
    );
  });

  it("background jobs keep the patient behaviour: a timeout is retried (up to 5 attempts)", async () => {
    const s = await setup("LimBackground");
    const { p, calls } = flaky([timeout(), timeout(), timeout(), timeout(), timeout()]);
    await runAgent(s.actor, agent, { accountId: s.account.id }, trigger("c"), {
      provider: p,
      promptsDir: PROMPTS,
      sleep: noSleep,
    });
    expect(calls).toHaveLength(5);
  });

  it("a per-request timeout set by the caller reaches the provider", async () => {
    const s = await setup("LimReqTimeout");
    const { p, calls } = flaky([]);
    await runAgent(s.actor, agent, { accountId: s.account.id }, trigger("d"), {
      provider: p,
      promptsDir: PROMPTS,
      interactive: true,
      timeoutMs: 42_000,
    });
    expect(calls[0]!.timeoutMs).toBe(42_000);
  });
});

// ── the Ask AI loop ──────────────────────────────────────────────────────────────────────────────
type Script = {
  plan: Array<
    | { action: "call" | "answer"; calls?: Array<{ tool: string; input: Record<string, unknown> }> }
    | Error
  >;
  answer?: Error;
  /** Milliseconds the fake clock advances on every planning call. */
  planCostMs?: number;
};

function askProvider(
  script: Script,
  seen: {
    plans: Array<StructuredRequest<unknown>>;
    answers: Array<StructuredRequest<unknown>>;
    clock: { t: number };
  },
) {
  const steps = [...script.plan];
  const p: AiProvider = {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      let out: unknown;
      if (req.promptRef.startsWith("ask-ai-plan@")) {
        seen.plans.push(req as StructuredRequest<unknown>);
        seen.clock.t += script.planCostMs ?? 0;
        const next = steps.shift() ?? { action: "answer" as const };
        if (next instanceof Error) throw next;
        out = { action: next.action, calls: next.calls ?? [] };
      } else {
        seen.answers.push(req as StructuredRequest<unknown>);
        if (script.answer) throw script.answer;
        const id = /"sourceId": "([^"]+)"/.exec(req.input)?.[1] ?? "none";
        out = {
          reasoningSummary: "Used the records.",
          confidence: 0.7,
          proposedActions: [],
          answer: "Quartz is on the list.",
          citations: [{ sourceType: "Account", sourceId: id }],
          figures: [],
        };
      }
      return {
        output: (req.schema as z.ZodType).parse(out) as T,
        stopReason: "end_turn",
        model: "test-model",
        requestId: randomUUID(),
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 1,
      };
    },
  };
  return p;
}

async function askSetup(label: string) {
  const { actor, workspace } = await createTestAdmin(label);
  const db = scopedDb(actor);
  await db.account.create({
    data: { workspaceId: workspace.id, name: "Quartz Ltd", tier: "MID_TOUCH" },
  });
  return { actor, db };
}
const newSeen = () => ({
  plans: [] as Array<StructuredRequest<unknown>>,
  answers: [] as Array<StructuredRequest<unknown>>,
  clock: { t: 1_000_000 },
});
const search = {
  action: "call" as const,
  calls: [{ tool: "searchAccounts", input: { query: "Quartz" } }],
};

describe("Ask AI: a timeout ends the question once, with an honest answer, and never crashes the page", () => {
  it("an answer-step timeout: ONE call, FAILED PROVIDER_TIMEOUT at attempt 1, the honest fallback is saved", async () => {
    const w = await askSetup("AskAnswerTimeout");
    const seen = newSeen();
    const res = await askQuestion(
      w.actor,
      { question: "Which accounts are at risk and why?" },
      { provider: askProvider({ plan: [search], answer: timeout() }, seen), sleep: async () => {} },
    );
    expect(res.status).toBe("FAILED");
    expect(seen.answers).toHaveLength(1); // not 3 or 5
    const run = await w.db.agentRun.findUniqueOrThrow({ where: { id: res.runId! } });
    expect(run).toMatchObject({ status: "FAILED", errorCode: "PROVIDER_TIMEOUT", attempt: 1 });
    const msg = await w.db.askMessage.findFirstOrThrow({ where: { role: "ASSISTANT" } });
    expect(msg.content).toBe(ASK_TIMEOUT_MESSAGE);
    expect(ASK_TIMEOUT_MESSAGE).toMatch(/too long/i);
    expect(ASK_TIMEOUT_MESSAGE).toMatch(/nothing was saved as an answer/i);
  });

  it("a planning timeout on the first step does not throw: no answer call, a failed run and the honest fallback are saved", async () => {
    const w = await askSetup("AskPlanTimeout");
    const seen = newSeen();
    const res = await askQuestion(
      w.actor,
      { question: "Which accounts are at risk and why?" },
      { provider: askProvider({ plan: [timeout()] }, seen) },
    );
    expect(res.status).toBe("FAILED");
    expect(seen.answers).toHaveLength(0); // nothing was retrieved, so there is nothing to answer from
    // The DB rule that every assistant message links to a run is kept: the run says it failed.
    const run = await w.db.agentRun.findUniqueOrThrow({ where: { id: res.runId! } });
    expect(run).toMatchObject({
      agentKey: "ask-ai",
      status: "FAILED",
      errorCode: "PROVIDER_TIMEOUT",
      inputTokens: 0,
      output: null,
    });
    const msg = await w.db.askMessage.findFirstOrThrow({ where: { role: "ASSISTANT" } });
    expect(msg.content).toBe(ASK_TIMEOUT_MESSAGE);
    expect(msg.agentRunId).toBe(run.id);
    expect(await w.db.agentRun.count({ where: { agentKey: "ask-ai" } })).toBe(1);
  });

  it("a planning timeout after something was retrieved still answers from what was retrieved", async () => {
    const w = await askSetup("AskPlanLate");
    const seen = newSeen();
    const res = await askQuestion(
      w.actor,
      { question: "Which accounts are at risk and why?" },
      { provider: askProvider({ plan: [search, timeout()] }, seen) },
    );
    expect(res.status).toBe("SUCCEEDED");
    expect(seen.answers).toHaveLength(1);
  });

  it("any other planning failure is handled the same way, not thrown", async () => {
    const w = await askSetup("AskPlanBoom");
    const res = await askQuestion(
      w.actor,
      { question: "Which accounts are at risk and why?" },
      { provider: askProvider({ plan: [new Error("socket hang up")] }, newSeen()) },
    );
    expect(res.status).toBe("FAILED");
    expect(res.assistantMessageId).not.toBeNull();
  });
});

describe("Ask AI: a total time limit keeps the request inside the proxy's 100 s", () => {
  it("planning stops once its time budget is spent, and the answer call's timeout is bounded by what is left", async () => {
    const w = await askSetup("AskDeadline");
    const seen = newSeen();
    const res = await askQuestion(
      w.actor,
      { question: "Which accounts are at risk and why?" },
      {
        // Every planning call "takes" 30 s on the fake clock and keeps asking for more tools.
        provider: askProvider({ plan: [search, search, search, search], planCostMs: 30_000 }, seen),
        nowMs: () => seen.clock.t,
      },
    );
    expect(res.status).toBe("SUCCEEDED");
    expect(seen.plans).toHaveLength(1); // the 25 s planning budget was gone after one 30 s call
    const t = seen.answers[0]!.timeoutMs!;
    expect(t).toBeLessThanOrEqual(60_000);
    expect(t).toBeGreaterThanOrEqual(15_000);
    expect(30_000 + t).toBeLessThanOrEqual(90_000); // elapsed + answer timeout stays under 100 s
  });

  it("planning calls carry their own short timeout, and the answer call a bounded one", async () => {
    const w = await askSetup("AskTimeouts");
    const seen = newSeen();
    await askQuestion(
      w.actor,
      { question: "Which accounts are at risk and why?" },
      { provider: askProvider({ plan: [search] }, seen), nowMs: () => seen.clock.t },
    );
    expect(seen.plans[0]!.timeoutMs).toBe(20_000);
    expect(seen.answers[0]!.timeoutMs).toBe(60_000);
  });
});
