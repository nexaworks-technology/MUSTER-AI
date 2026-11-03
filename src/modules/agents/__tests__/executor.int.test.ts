import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AiProviderError,
  AiTransientError,
  type AiProvider,
  type StructuredRequest,
  type StructuredResult,
} from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { defineAgent } from "../define";
import { createOnce, runAgent, type ExecutorDeps } from "../executor";
import { baseAgentOutput } from "../schemas";
import { renderableRun } from "../service";

/**
 * The executor (M4 §5, Rules 1, 4, 5; D-74). A fake provider stands in for the model: tests never
 * call the live API (M4 rule 6). Each case reads the AgentRun row and the AuditLog it wrote.
 */
const PROMPTS = path.join(import.meta.dirname, "fixtures/prompts");

type Reply = Partial<StructuredResult<unknown>> | Error;

function fakeProvider(replies: Reply[]) {
  const calls: Array<StructuredRequest<unknown>> = [];
  const provider: AiProvider = {
    name: "recorded",
    async generateStructured<T>(request: StructuredRequest<T>) {
      calls.push(request as StructuredRequest<unknown>);
      const next = replies.length > 1 ? replies.shift()! : replies[0]!;
      if (next instanceof Error) throw next;
      return {
        output: null,
        stopReason: "end_turn",
        model: "model-from-env-standard",
        requestId: "req",
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 5,
        ...next,
      } as StructuredResult<T>;
    },
  };
  return { provider, calls };
}

const output = z.object({
  ...baseAgentOutput.shape,
  items: z.array(z.object({ text: z.string(), citesIds: z.array(z.string()) })).max(2),
});

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const account = await db.account.create({
    data: { workspaceId: actor.workspaceId, name: `${label} Logistics`, tier: "HIGH_TOUCH" },
  });
  const agent = defineAgent({
    key: "test-agent",
    version: "1.0.0",
    description: "test",
    modelTier: "standard",
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
        facts: { confidence: 0.42 },
      };
    },
    extraCitations: (o) =>
      o.items.flatMap((i) => i.citesIds.map((id) => ({ sourceType: "Account", sourceId: id }))),
    narrative: (o) => o.items.map((i) => i.text),
    forbiddenNumericFields: ["confidence", "amountMinor"],
    approvalPolicy: "INTERNAL",
    async act(o, ctx) {
      // Creates one approval per item, keyed by sourceKey; throws once to simulate a crash.
      const effects = [];
      for (const [i, item] of o.items.entries()) {
        const row = await createOnce(
          () =>
            ctx.db.approval.create({
              data: {
                workspaceId: ctx.workspaceId,
                accountId: ctx.accountId!,
                kind: "CREATE_TASK",
                reason: item.text,
                proposedByAgentRunId: ctx.runId,
                proof: [{ sourceType: "Account", sourceId: ctx.accountId! }],
                requiredLevel: "DRAFT_FOR_APPROVAL",
                sourceKey: ctx.sourceKey(i),
              },
            }),
          () =>
            ctx.db.approval.findUnique({
              where: {
                workspaceId_sourceKey: {
                  workspaceId: ctx.workspaceId,
                  sourceKey: ctx.sourceKey(i),
                },
              },
            }),
        );
        effects.push({ type: "Approval", id: row.id });
        if (crashOnce.armed) {
          crashOnce.armed = false;
          throw new Error("worker crashed after persist");
        }
      }
      return { effects, actionTaken: "APPROVAL_REQUESTED" as const };
    },
  });
  return { actor, db, account, agent };
}

const crashOnce = { armed: false };
const good = (accountId: string) => ({
  reasoningSummary: "Seat use is low.",
  confidence: 0.9,
  citations: [{ sourceType: "Account", sourceId: accountId, quote: "36 of 207 seats" }],
  proposedActions: [
    { type: "createTask", summary: "Review seats", confidence: 0.99, amountMinor: 1 },
  ],
  items: [{ text: "Only 36 of 207 seats are used.", citesIds: [accountId] }],
});
const noSleep: ExecutorDeps = { sleep: async () => {}, promptsDir: PROMPTS, random: () => 0 };

describe("agent executor", () => {
  it("a SUCCEEDED run carries every audit field, and the audit log names it (Rule 5)", async () => {
    const { actor, db, account, agent } = await setup("ExecOk");
    const { provider } = fakeProvider([{ output: good(account.id) }]);
    const out = await runAgent(
      actor,
      agent,
      { accountId: account.id },
      { type: "test", id: "1" },
      { ...noSleep, provider },
    );
    expect(out).toMatchObject({ kind: "run", status: "SUCCEEDED", reused: false });
    const run = await db.agentRun.findFirstOrThrow({ where: { agentKey: "test-agent" } });
    expect(run).toMatchObject({
      agentKey: "test-agent",
      agentVersion: "1.0.0",
      promptName: "test-agent",
      promptVersion: "1.0.0",
      model: "model-from-env-standard",
      modelTier: "standard",
      inputRefs: [{ sourceType: "Account", sourceId: account.id }],
      reasoningSummary: "Seat use is low.",
      confidence: 0.9,
      inputTokens: 100,
      outputTokens: 50,
      actionTaken: "APPROVAL_REQUESTED",
    });
    expect(run.output).toBeTruthy();
    expect(run.effects).toHaveLength(1);
    // Forbidden numerics were overwritten from code (0.42) and removed (amountMinor).
    expect((run.output as { proposedActions: unknown[] }).proposedActions).toEqual([
      { type: "createTask", summary: "Review seats", confidence: 0.42 },
    ]);
    const audit = await db.auditLog.findFirst({ where: { agentRunId: run.id } });
    expect(audit).toMatchObject({ actorType: "AGENT", action: "agent.run.succeeded" });
    expect(await renderableRun(actor, run.id)).not.toBeNull();
  });

  it("INVALID_OUTPUT after exactly one repair call; nothing is rendered", async () => {
    const { actor, db, account, agent } = await setup("ExecInvalid");
    const { provider, calls } = fakeProvider([
      { output: null, stopReason: "invalid_output", validationError: "items: required" },
    ]);
    const out = await runAgent(
      actor,
      agent,
      { accountId: account.id },
      { type: "test", id: "1" },
      { ...noSleep, provider },
    );
    expect(out).toMatchObject({ status: "INVALID_OUTPUT" });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toContain("did not match the required format");
    const run = await db.agentRun.findFirstOrThrow({});
    expect(run.output).toBeNull();
    expect(await renderableRun(actor, run.id)).toBeNull();
    expect(await db.approval.count()).toBe(0);
  });

  it("an uncited answer is UNCITED: a citation to a record it was not given, or an invented number", async () => {
    const { actor, db, account, agent } = await setup("ExecUncited");
    const bad = {
      ...good(account.id),
      citations: [{ sourceType: "Account", sourceId: "someone-else" }],
    };
    const { provider } = fakeProvider([{ output: bad }]);
    expect(
      await runAgent(
        actor,
        agent,
        { accountId: account.id },
        { type: "t", id: "1" },
        { ...noSleep, provider },
      ),
    ).toMatchObject({ status: "UNCITED" });
    const invented = {
      ...good(account.id),
      items: [{ text: "Only 31 of 207 seats are used.", citesIds: [account.id] }],
    };
    const p2 = fakeProvider([{ output: invented }]);
    expect(
      await runAgent(
        actor,
        agent,
        { accountId: account.id },
        { type: "t", id: "2" },
        { ...noSleep, provider: p2.provider },
      ),
    ).toMatchObject({ status: "UNCITED" });
    const runs = await db.agentRun.findMany({ orderBy: { createdAt: "asc" } });
    expect(runs.map((r) => r.errorDetail)).toEqual([
      expect.stringContaining("which the run was not given"),
      expect.stringContaining('the number "31"'),
    ]);
    expect(await db.approval.count()).toBe(0);
  });

  it("the same trigger twice gives one AgentRun and one model call", async () => {
    const { actor, db, account, agent } = await setup("ExecIdem");
    const { provider, calls } = fakeProvider([{ output: good(account.id) }]);
    const t = { type: "signal", id: "s1" };
    await runAgent(actor, agent, { accountId: account.id }, t, { ...noSleep, provider });
    const again = await runAgent(actor, agent, { accountId: account.id }, t, {
      ...noSleep,
      provider,
    });
    expect(again).toMatchObject({ reused: true, status: "SUCCEEDED" });
    expect(await db.agentRun.count()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(await db.approval.count()).toBe(1);
  });

  it("a crash after persist, then a retry, never duplicates the approval (sourceKey)", async () => {
    const { actor, db, account, agent } = await setup("ExecCrash");
    const { provider } = fakeProvider([{ output: good(account.id) }]);
    const t = { type: "signal", id: "crash" };
    crashOnce.armed = true;
    await expect(
      runAgent(actor, agent, { accountId: account.id }, t, { ...noSleep, provider }),
    ).rejects.toThrow("crashed");
    expect(await db.approval.count()).toBe(1);
    await runAgent(actor, agent, { accountId: account.id }, t, { ...noSleep, provider });
    expect(await db.approval.count()).toBe(1);
    const run = await db.agentRun.findFirstOrThrow({});
    expect(run.effects).toHaveLength(1);
  });

  it("over the daily token budget the run is SKIPPED with reason budget, and no model call", async () => {
    const { actor, db, account, agent } = await setup("ExecBudget");
    await db.workspaceSettings.upsert({
      where: { workspaceId: actor.workspaceId },
      create: { workspaceId: actor.workspaceId, data: { ai: { dailyTokenBudget: 120 } } },
      update: { data: { ai: { dailyTokenBudget: 120 } } },
    });
    const { provider, calls } = fakeProvider([{ output: good(account.id) }]);
    await runAgent(
      actor,
      agent,
      { accountId: account.id },
      { type: "t", id: "1" },
      { ...noSleep, provider },
    );
    const second = await runAgent(
      actor,
      agent,
      { accountId: account.id },
      { type: "t", id: "2" },
      { ...noSleep, provider },
    );
    expect(second).toMatchObject({ status: "SKIPPED" });
    expect(calls).toHaveLength(1);
    const skipped = await db.agentRun.findFirstOrThrow({ where: { status: "SKIPPED" } });
    expect(skipped).toMatchObject({ errorCode: "BUDGET", errorDetail: "budget" });
  });

  it("with no API key the product says it is not configured and writes no run", async () => {
    const { actor, db, account, agent } = await setup("ExecNoKey");
    const out = await runAgent(
      actor,
      agent,
      { accountId: account.id },
      { type: "t", id: "1" },
      { promptsDir: PROMPTS },
    );
    expect(out).toEqual({ kind: "not_configured", reason: "ANTHROPIC_API_KEY is not set" });
    expect(await db.agentRun.count()).toBe(0);
  });

  it("a refusal is FAILED / MODEL_DECLINED, never retried, and writes nothing (D-74)", async () => {
    const { actor, db, account, agent } = await setup("ExecDeclined");
    const { provider, calls } = fakeProvider([{ output: null, stopReason: "refusal" }]);
    const out = await runAgent(
      actor,
      agent,
      { accountId: account.id },
      { type: "t", id: "1" },
      { ...noSleep, provider },
    );
    expect(out).toMatchObject({ status: "FAILED" });
    expect(calls).toHaveLength(1);
    const run = await db.agentRun.findFirstOrThrow({});
    expect(run).toMatchObject({ errorCode: "MODEL_DECLINED", output: null });
    expect(await db.approval.count()).toBe(0);
    expect(await db.auditLog.findFirst({ where: { agentRunId: run.id } })).toMatchObject({
      action: "agent.run.failed",
    });
  });

  it("transient errors retry 4 times with backoff, then succeed or fail with the reason (D-74)", async () => {
    const { actor, db, account, agent } = await setup("ExecRetry");
    const sleeps: number[] = [];
    const deps = { ...noSleep, sleep: async (ms: number) => void sleeps.push(ms) };
    const busy = () => new AiTransientError("http_529", "busy");
    const p1 = fakeProvider([busy(), busy(), { output: good(account.id) }]);
    expect(
      await runAgent(
        actor,
        agent,
        { accountId: account.id },
        { type: "t", id: "1" },
        { ...deps, provider: p1.provider },
      ),
    ).toMatchObject({ status: "SUCCEEDED" });
    expect((await db.agentRun.findFirstOrThrow({ where: { triggerId: "1" } })).attempt).toBe(3);
    expect(sleeps).toEqual([2_000, 4_000]);

    const p2 = fakeProvider([busy()]);
    expect(
      await runAgent(
        actor,
        agent,
        { accountId: account.id },
        { type: "t", id: "2" },
        { ...deps, provider: p2.provider },
      ),
    ).toMatchObject({ status: "FAILED" });
    expect(p2.calls).toHaveLength(5);
    expect(await db.agentRun.findFirstOrThrow({ where: { triggerId: "2" } })).toMatchObject({
      attempt: 5,
      errorCode: "PROVIDER_HTTP_529",
      output: null,
    });
  });

  it("a permanent provider error fails at once, without retries", async () => {
    const { actor, db, account, agent } = await setup("ExecPermanent");
    const { provider, calls } = fakeProvider([new AiProviderError("http_400", "bad request")]);
    await runAgent(
      actor,
      agent,
      { accountId: account.id },
      { type: "t", id: "1" },
      { ...noSleep, provider },
    );
    expect(calls).toHaveLength(1);
    expect(await db.agentRun.findFirstOrThrow({})).toMatchObject({
      status: "FAILED",
      errorCode: "PROVIDER_HTTP_400",
    });
  });
});
