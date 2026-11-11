import { describe, expect, it } from "vitest";
import type { AiProvider, BatchItem, BatchRequest, StructuredRequest } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { collectBatches } from "../executor";
import { promiseKeeper, sweepPromiseKeeper } from "../definitions/promise-keeper";

/**
 * AI cost session, item 2, at the sweep: the Promise Keeper sweep (one of the bulk entry points) hands
 * its accounts to the provider as ONE batch, makes no real-time call, and the run is finished when
 * the batch result is collected, with its side effect (the chase task) applied only then.
 */
const TODAY = new Date("2026-11-02T12:00:00Z");

async function world(label: string, promises = 2) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const ids: string[] = [];
  for (let i = 0; i < promises; i++) {
    const account = await db.account.create({
      data: {
        workspaceId: ws,
        name: `Halden ${i}`,
        tier: "MID_TOUCH",
        ownerMembershipId: actor.membershipId,
      },
    });
    const p = await db.promise.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        party: "US",
        what: `CSV export fix ${i}`,
        dueDate: new Date("2026-10-24T00:00:00Z"),
        status: "LATE",
        statusReason: "9 days late.",
        quote: "Engineering will have the CSV export fix to you by October 24.",
        sourceType: "CALL_TRANSCRIPT",
        sourceId: `t${i}`,
        dedupeKey: `k${i}`,
        origin: "HUMAN",
      },
    });
    ids.push(p.id);
  }
  return { actor, db, ids };
}

function batchProvider() {
  const realtime: Array<StructuredRequest<unknown>> = [];
  const submitted: BatchRequest[][] = [];
  const answer = (req: { input: string }) => {
    const id = /"sourceId": "([^"]+)"/.exec(req.input)![1]!;
    return {
      reasoningSummary: "The promise is late.",
      confidence: 0.8,
      proposedActions: [],
      citations: [{ sourceType: "Promise", sourceId: id }],
      ownerMembershipId: null,
      chaseDetail: "Chase it.",
    };
  };
  const provider: AiProvider = {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      realtime.push(req as StructuredRequest<unknown>);
      throw new Error("a sweep must not use real-time calls when batches are available");
    },
    async submitBatch(requests) {
      submitted.push(requests);
      return { batchId: "batch_1" };
    },
    async getBatch() {
      return {
        done: true,
        items: submitted.flat().map((r): BatchItem => ({
          customId: r.customId,
          outcome: "succeeded",
          text: JSON.stringify(answer(r)),
          stopReason: "end_turn",
          model: "haiku",
          requestId: null,
          inputTokens: 30,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        })),
      };
    },
  };
  return { provider, realtime, submitted };
}

describe("a sweep submits its jobs as one batch", () => {
  it("Promise Keeper sweep: one batch of two, no real-time call, results consumed on collect", async () => {
    const w = await world("SweepBatch", 2);
    const { provider, realtime, submitted } = batchProvider();
    // A provider that answers only when polled: hold the answer back until collect.
    const originalGet = provider.getBatch!;
    let release = false;
    provider.getBatch = async (id) => (release ? originalGet(id) : { done: false, items: [] });

    const out = await sweepPromiseKeeper(w.actor, { provider, clock: () => TODAY });
    expect(out).toMatchObject({ notConfigured: false, asked: 2 });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toHaveLength(2);
    expect(submitted[0]!.every((r) => r.tier === "fast")).toBe(true);
    expect(realtime).toHaveLength(0);

    // Submitted, not finished: no chase task yet, the runs wait on the batch.
    expect(await w.db.task.count()).toBe(0);
    const waiting = await w.db.agentRun.findMany({ where: { agentKey: promiseKeeper.key } });
    expect(waiting.map((r) => r.status)).toEqual(["RUNNING", "RUNNING"]);
    expect(waiting.every((r) => r.batchId === "batch_1")).toBe(true);

    // A second sweep while the batch is pending adds nothing (no second batch, no second run).
    await sweepPromiseKeeper(w.actor, { provider, clock: () => TODAY });
    expect(submitted).toHaveLength(1);

    // The batch finishes; collecting applies each run's side effect through the same executor.
    release = true;
    expect(
      await collectBatches(w.actor, {
        provider,
        clock: () => TODAY,
        resolveAgent: () => promiseKeeper,
      }),
    ).toEqual({ batches: 1, finished: 2 });
    expect(await w.db.task.count()).toBe(2);
    const done = await w.db.agentRun.findMany({ where: { agentKey: promiseKeeper.key } });
    expect(done.map((r) => r.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    expect(done.every((r) => r.model === "haiku" && r.inputTokens === 30)).toBe(true);
  });
});
