import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  AiProvider,
  BatchItem,
  BatchRequest,
  StructuredRequest,
  StructuredResult,
} from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { defineAgent } from "../define";
import { collectBatches, runAgent, runAgentsBatch } from "../executor";
import { baseAgentOutput } from "../schemas";

/**
 * AI cost session (docs/AI-COST-2026-11-11.md), items 2, 3 and 4 at the executor:
 * cache tokens and an input hash on every run; an unchanged account makes no model call and no
 * batch entry; bulk jobs go to the provider as ONE batch whose results are consumed later through
 * the same citation and safety checks as a real-time call. A fake provider stands in for the
 * model: these tests never call the live API.
 */
const PROMPTS = path.join(import.meta.dirname, "fixtures/prompts");

const output = z.object({
  ...baseAgentOutput.shape,
  items: z.array(z.object({ text: z.string(), citesIds: z.array(z.string()) })).max(2),
});

const accountIdOf = (input: string) => /"sourceId": "([^"]+)"/.exec(input)![1]!;
const answerFor = (accountId: string, quote = "36 of 207 seats") => ({
  reasoningSummary: "Seat use is low.",
  confidence: 0.9,
  citations: [{ sourceType: "Account", sourceId: accountId, quote }],
  proposedActions: [],
  items: [{ text: "Only 36 of 207 seats are used.", citesIds: [accountId] }],
});

interface Spy {
  realtime: Array<StructuredRequest<unknown>>;
  submitted: BatchRequest[][];
  polls: number;
}

/** A provider with real-time and batch support. `batchText` decides each batch item's raw text. */
function provider(opts: {
  batchText?: (req: BatchRequest) => string | null;
  batchItem?: (req: BatchRequest) => BatchItem | null;
  noBatch?: boolean;
  cache?: { read: number; write: number };
  neverDone?: boolean;
}) {
  const spy: Spy = { realtime: [], submitted: [], polls: 0 };
  const p: AiProvider = {
    name: "recorded",
    async generateStructured<T>(request: StructuredRequest<T>) {
      spy.realtime.push(request as StructuredRequest<unknown>);
      return {
        output: answerFor(accountIdOf(request.input)) as T,
        stopReason: "end_turn",
        model: "model-fast",
        requestId: "req",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: opts.cache?.read ?? 0,
        cacheCreationTokens: opts.cache?.write ?? 0,
        latencyMs: 5,
      } as StructuredResult<T>;
    },
  };
  if (!opts.noBatch) {
    p.submitBatch = async (requests) => {
      spy.submitted.push(requests);
      return { batchId: `batch_${spy.submitted.length}` };
    };
    p.getBatch = async () => {
      spy.polls++;
      if (opts.neverDone || spy.polls < 2) return { done: false, items: [] };
      const items = spy.submitted.flat().map(
        (r): BatchItem =>
          opts.batchItem?.(r) ?? {
            customId: r.customId,
            outcome: "succeeded",
            text: opts.batchText
              ? opts.batchText(r)
              : JSON.stringify(answerFor(accountIdOf(r.input))),
            stopReason: "end_turn",
            model: "model-fast",
            requestId: "req",
            inputTokens: 80,
            outputTokens: 40,
            cacheReadTokens: opts.cache?.read ?? 0,
            cacheCreationTokens: opts.cache?.write ?? 0,
          },
      );
      return { done: true, items };
    };
  }
  return { provider: p, spy };
}

async function setup(label: string, accounts = 1) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const accs = [];
  for (let i = 0; i < accounts; i++)
    accs.push(
      await db.account.create({
        data: { workspaceId: actor.workspaceId, name: `${label} ${i}`, tier: "HIGH_TOUCH" },
      }),
    );
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
    extraCitations: (o) =>
      o.items.flatMap((i) => i.citesIds.map((id) => ({ sourceType: "Account", sourceId: id }))),
    narrative: (o) => o.items.map((i) => i.text),
    forbiddenNumericFields: ["confidence", "amountMinor"],
    approvalPolicy: "INTERNAL",
  });
  return { actor, db, accs, agent };
}

const trig = (id: string) => ({ type: "test", id });

describe("cache tokens and the input hash are recorded on the run (item 3)", () => {
  it("stores cache-read and cache-write tokens, and a hash of the exact input", async () => {
    const { actor, db, accs, agent } = await setup("CostCache");
    const { provider: p } = provider({ cache: { read: 900, write: 50 } });
    const out = await runAgent(actor, agent, { accountId: accs[0]!.id }, trig("t1"), {
      provider: p,
      promptsDir: PROMPTS,
    });
    expect(out).toMatchObject({ kind: "run", status: "SUCCEEDED" });
    const run = await db.agentRun.findFirstOrThrow({ where: { agentKey: "test-agent" } });
    expect(run).toMatchObject({ cacheReadTokens: 900, cacheCreationTokens: 50, modelTier: "fast" });
    expect(run.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("an unchanged account makes no model call (item 4)", () => {
  it("skips when the exact inputs equal the last successful run, and runs again once they change", async () => {
    const { actor, db, accs, agent } = await setup("CostUnchanged");
    const { provider: p, spy } = provider({});
    const deps = { provider: p, promptsDir: PROMPTS, skipIfUnchanged: true };
    const first = await runAgent(actor, agent, { accountId: accs[0]!.id }, trig("night-1"), deps);
    expect(first).toMatchObject({ kind: "run", status: "SUCCEEDED" });
    expect(spy.realtime).toHaveLength(1);

    // A later night, same records: no call, no new run, and the outcome says why.
    const second = await runAgent(actor, agent, { accountId: accs[0]!.id }, trig("night-2"), deps);
    expect(second).toMatchObject({ kind: "run", unchanged: true });
    expect(spy.realtime).toHaveLength(1);
    expect(await db.agentRun.count({ where: { agentKey: "test-agent" } })).toBe(1);

    // The same request without the gate (a person asking) still runs.
    await runAgent(actor, agent, { accountId: accs[0]!.id }, trig("asked"), {
      provider: p,
      promptsDir: PROMPTS,
    });
    expect(spy.realtime).toHaveLength(2);

    // The records changed: the gate lets it through.
    await db.account.update({ where: { id: accs[0]!.id }, data: { name: "Renamed Logistics" } });
    const third = await runAgent(actor, agent, { accountId: accs[0]!.id }, trig("night-3"), deps);
    expect(third).toMatchObject({ kind: "run", status: "SUCCEEDED" });
    expect((third as { unchanged?: boolean }).unchanged).toBeUndefined();
    expect(spy.realtime).toHaveLength(3);
  });
});

describe("bulk jobs go to the provider as one batch (item 2)", () => {
  it("submits every changed account in ONE batch, none in real time, and none for an unchanged one", async () => {
    const { actor, db, accs, agent } = await setup("CostBatch", 3);
    const { provider: p, spy } = provider({});
    // accs[0] already has a successful run on exactly these records.
    await runAgent(actor, agent, { accountId: accs[0]!.id }, trig("earlier"), {
      provider: p,
      promptsDir: PROMPTS,
    });
    spy.realtime.length = 0;

    const outcomes = await runAgentsBatch(
      actor,
      accs.map((a) => ({ def: agent, input: { accountId: a.id }, trigger: trig("night") })),
      { provider: p, promptsDir: PROMPTS, skipIfUnchanged: true },
    );
    expect(spy.submitted).toHaveLength(1);
    expect(spy.submitted[0]).toHaveLength(2); // accs[1] and accs[2] only
    expect(spy.realtime).toHaveLength(0); // nothing went to the real-time API
    expect(outcomes[0]).toMatchObject({ kind: "run", unchanged: true });
    expect(await db.agentRun.count({ where: { agentKey: "test-agent" } })).toBe(3); // 1 + 2 new

    // Submitted, not finished: the runs wait for the batch.
    const pending = await db.agentRun.findMany({ where: { batchId: { not: null } } });
    expect(pending).toHaveLength(2);
    expect(pending.every((r) => r.status === "RUNNING" && r.batchId === "batch_1")).toBe(true);
    expect(new Set(spy.submitted[0]!.map((r) => r.customId))).toEqual(
      new Set(pending.map((r) => r.id)),
    );
    expect(spy.submitted[0]!.every((r) => r.tier === "fast")).toBe(true);
  });

  it("consumes the results later: runs finish with output, tokens and cache tokens, through the same checks", async () => {
    const { actor, db, accs, agent } = await setup("CostCollect", 2);
    const { provider: p, spy } = provider({ cache: { read: 700, write: 0 } });
    const deps = { provider: p, promptsDir: PROMPTS, skipIfUnchanged: true };
    await runAgentsBatch(
      actor,
      accs.map((a) => ({ def: agent, input: { accountId: a.id }, trigger: trig("night") })),
      deps,
    );
    // The submit-time poll said "not done yet": nothing is finished.
    expect(await db.agentRun.count({ where: { status: "SUCCEEDED" } })).toBe(0);

    const collected = await collectBatches(actor, { ...deps, resolveAgent: () => agent });
    expect(collected).toEqual({ batches: 1, finished: 2 });
    const runs = await db.agentRun.findMany({ where: { agentKey: "test-agent" } });
    expect(runs).toHaveLength(2);
    for (const r of runs) {
      expect(r).toMatchObject({
        status: "SUCCEEDED",
        inputTokens: 80,
        outputTokens: 40,
        cacheReadTokens: 700,
        model: "model-fast",
      });
      expect(r.reasoningSummary).toBe("Seat use is low.");
    }
    expect(spy.realtime).toHaveLength(0);
    // Collecting again changes nothing.
    expect(await collectBatches(actor, { ...deps, resolveAgent: () => agent })).toEqual({
      batches: 0,
      finished: 0,
    });
  });

  it("keeps the citation guard exactly as strict: a made-up quote is UNCITED, nothing is written", async () => {
    const { actor, db, accs, agent } = await setup("CostCite");
    const { provider: p } = provider({
      batchText: (r) =>
        JSON.stringify(answerFor(accountIdOf(r.input), "words that are in no record")),
    });
    const deps = { provider: p, promptsDir: PROMPTS };
    await runAgentsBatch(
      actor,
      [{ def: agent, input: { accountId: accs[0]!.id }, trigger: trig("n") }],
      deps,
    );
    await collectBatches(actor, { ...deps, resolveAgent: () => agent });
    const run = await db.agentRun.findFirstOrThrow({ where: { agentKey: "test-agent" } });
    expect(run.status).toBe("UNCITED");
    expect(run.output).toBeNull();
  });

  it("a failed batch request fails that run with the provider's reason; others finish", async () => {
    const { actor, db, accs, agent } = await setup("CostFail", 2);
    let n = 0;
    const { provider: p } = provider({
      batchItem: (r) =>
        n++ === 0
          ? { customId: r.customId, outcome: "errored", code: "overloaded_error", detail: "busy" }
          : null,
    });
    const deps = { provider: p, promptsDir: PROMPTS };
    await runAgentsBatch(
      actor,
      accs.map((a) => ({ def: agent, input: { accountId: a.id }, trigger: trig("n") })),
      deps,
    );
    await collectBatches(actor, { ...deps, resolveAgent: () => agent });
    const runs = await db.agentRun.findMany({ where: { agentKey: "test-agent" } });
    expect(runs.map((r) => r.status).sort()).toEqual(["FAILED", "SUCCEEDED"]);
    expect(runs.find((r) => r.status === "FAILED")!.errorCode).toBe("PROVIDER_OVERLOADED_ERROR");
  });

  it("text that is not the required format gets the one real-time repair call, as before", async () => {
    const { actor, db, accs, agent } = await setup("CostRepair");
    const { provider: p, spy } = provider({ batchText: () => "not json at all" });
    const deps = { provider: p, promptsDir: PROMPTS };
    await runAgentsBatch(
      actor,
      [{ def: agent, input: { accountId: accs[0]!.id }, trigger: trig("n") }],
      deps,
    );
    await collectBatches(actor, { ...deps, resolveAgent: () => agent });
    expect(spy.realtime).toHaveLength(1); // the repair call
    expect(spy.realtime[0]!.input).toContain("did not match the required format");
    expect((await db.agentRun.findFirstOrThrow({ where: { agentKey: "test-agent" } })).status).toBe(
      "SUCCEEDED",
    );
  });

  it("an account whose records changed while the batch ran is skipped, not checked against new records", async () => {
    const { actor, db, accs, agent } = await setup("CostStale");
    const { provider: p } = provider({});
    const deps = { provider: p, promptsDir: PROMPTS };
    await runAgentsBatch(
      actor,
      [{ def: agent, input: { accountId: accs[0]!.id }, trigger: trig("n") }],
      deps,
    );
    await db.account.update({ where: { id: accs[0]!.id }, data: { name: "Changed Mid-Batch" } });
    await collectBatches(actor, { ...deps, resolveAgent: () => agent });
    const run = await db.agentRun.findFirstOrThrow({ where: { agentKey: "test-agent" } });
    expect(run).toMatchObject({ status: "SKIPPED", errorCode: "STALE_BATCH_INPUT" });
  });

  it("a provider with no batch support runs each job in real time instead", async () => {
    const { actor, accs, agent } = await setup("CostNoBatch", 2);
    const { provider: p, spy } = provider({ noBatch: true });
    const outcomes = await runAgentsBatch(
      actor,
      accs.map((a) => ({ def: agent, input: { accountId: a.id }, trigger: trig("n") })),
      { provider: p, promptsDir: PROMPTS },
    );
    expect(spy.realtime).toHaveLength(2);
    expect(outcomes.map((o) => (o.kind === "run" ? o.status : o.kind))).toEqual([
      "SUCCEEDED",
      "SUCCEEDED",
    ]);
  });

  it("re-running a sweep while a batch is pending does not submit those runs again", async () => {
    const { actor, accs, agent } = await setup("CostResubmit");
    const { provider: p, spy } = provider({ neverDone: true });
    const jobs = [{ def: agent, input: { accountId: accs[0]!.id }, trigger: trig("n") }];
    const deps = { provider: p, promptsDir: PROMPTS };
    await runAgentsBatch(actor, jobs, deps);
    await runAgentsBatch(actor, jobs, deps);
    expect(spy.submitted).toHaveLength(1);
  });
});
