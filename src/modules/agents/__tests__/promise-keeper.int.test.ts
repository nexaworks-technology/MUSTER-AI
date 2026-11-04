import { describe, expect, it } from "vitest";
import { addDays, businessClock, todayIn } from "@/lib/dates";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { runAgent } from "../executor";
import { promiseKeeper, sweepPromiseKeeper } from "../definitions/promise-keeper";

/**
 * Promise Keeper (M9 B3, Q-65): for a late promise of ours it makes an internal chase Task with an
 * owner and a date computed by code. It never contacts the customer: no Approval, no OutboundMessage.
 */
const TODAY = new Date("2026-11-02T12:00:00Z");

async function world(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Halden Retail",
      tier: "MID_TOUCH",
      ownerMembershipId: actor.membershipId,
    },
  });
  const promise = await db.promise.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      party: "US",
      what: "CSV export fix",
      dueDate: new Date("2026-10-24T00:00:00Z"),
      status: "LATE",
      statusReason: "9 days late: it was due on 2026-10-24 and nothing shows it was done.",
      quote: "Engineering will have the CSV export fix to you by October 24.",
      sourceType: "CALL_TRANSCRIPT",
      sourceId: "t1",
      dedupeKey: "k1",
      origin: "HUMAN",
    },
  });
  return { actor, db, ws, account, promise };
}
const provider = (
  ids: { promiseId: string; owner: string | null },
  detail = "Ask engineering for a date and tell Halden.",
): AiProvider => ({
  name: "recorded",
  async generateStructured<T>() {
    return {
      output: {
        reasoningSummary: "The promise is late.",
        confidence: 0.8,
        proposedActions: [],
        citations: [{ sourceType: "Promise", sourceId: ids.promiseId }],
        ownerMembershipId: ids.owner,
        chaseDetail: detail,
      } as T,
      stopReason: "end_turn",
      model: "recorded",
      requestId: null,
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
    };
  },
});

describe("Promise Keeper", () => {
  it("makes one internal chase task for a late promise: owner and date by code, linked to the promise, nothing to the customer", async () => {
    const w = await world("KeeperTask");
    const out = await runAgent(
      w.actor,
      promiseKeeper,
      { promiseId: w.promise.id },
      { type: "promise", id: w.promise.id },
      {
        provider: provider({ promiseId: w.promise.id, owner: w.actor.membershipId }),
        clock: () => TODAY,
      },
    );
    expect(out).toMatchObject({ kind: "run", status: "SUCCEEDED" });
    const t = await w.db.task.findFirstOrThrow({ where: { accountId: w.account.id } });
    expect(t).toMatchObject({
      title: "Chase late promise: CSV export fix",
      ownerMembershipId: w.actor.membershipId,
      origin: "AI",
      status: "OPEN",
      source: "SYSTEM",
    });
    expect(t.dueAt?.toISOString().slice(0, 10)).toBe(addDays(todayIn("UTC", businessClock), 1));
    expect(t.detail).toContain("Ask engineering");
    expect(t.agentRunId).not.toBeNull();
    expect(await w.db.approval.count()).toBe(0);
    expect(await w.db.outboundMessage.count()).toBe(0);
  });

  it("an owner the model names who is not a member falls back to the account owner (code decides)", async () => {
    const w = await world("KeeperOwner");
    await runAgent(
      w.actor,
      promiseKeeper,
      { promiseId: w.promise.id },
      { type: "promise", id: w.promise.id },
      { provider: provider({ promiseId: w.promise.id, owner: "made-up-id" }), clock: () => TODAY },
    );
    expect((await w.db.task.findFirstOrThrow()).ownerMembershipId).toBe(w.actor.membershipId);
  });

  it("does nothing for a promise that is not ours, not late, or already has a chase task", async () => {
    const w = await world("KeeperSkip");
    const p = (over: object) =>
      w.db.promise.create({
        data: {
          workspaceId: w.ws,
          accountId: w.account.id,
          party: "US",
          what: "w",
          status: "OPEN",
          statusReason: "r",
          dedupeKey: `k-${Math.random()}`,
          origin: "HUMAN",
          ...over,
        },
      });
    const customer = await p({ party: "CUSTOMER", status: "LATE" });
    const open = await p({ status: "OPEN" });
    for (const x of [customer, open])
      await runAgent(
        w.actor,
        promiseKeeper,
        { promiseId: x.id },
        { type: "promise", id: x.id },
        { provider: provider({ promiseId: x.id, owner: null }), clock: () => TODAY },
      );
    expect(await w.db.task.count()).toBe(0);
    await runAgent(
      w.actor,
      promiseKeeper,
      { promiseId: w.promise.id },
      { type: "promise", id: w.promise.id },
      { provider: provider({ promiseId: w.promise.id, owner: null }), clock: () => TODAY },
    );
    await runAgent(
      w.actor,
      promiseKeeper,
      { promiseId: w.promise.id },
      { type: "promise", id: `${w.promise.id}:again` },
      { provider: provider({ promiseId: w.promise.id, owner: null }), clock: () => TODAY },
    );
    expect(await w.db.task.count()).toBe(1);
  });

  it("the sweep asks once per late promise of ours that has no chase task", async () => {
    const w = await world("KeeperSweep");
    const calls: string[] = [];
    const p: AiProvider = {
      name: "recorded",
      async generateStructured<T>(req: StructuredRequest<T>) {
        calls.push(req.input);
        const id = /"sourceId": "([^"]+)"/.exec(req.input)![1]!;
        return {
          output: {
            reasoningSummary: "r",
            confidence: 0.8,
            proposedActions: [],
            citations: [{ sourceType: "Promise", sourceId: id }],
            ownerMembershipId: null,
            chaseDetail: "Chase it.",
          } as T,
          stopReason: "end_turn",
          model: "recorded",
          requestId: null,
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        };
      },
    };
    const first = await sweepPromiseKeeper(w.actor, { provider: p, clock: () => TODAY });
    expect(first).toMatchObject({ notConfigured: false, asked: 1 });
    const second = await sweepPromiseKeeper(w.actor, { provider: p, clock: () => TODAY });
    expect(second).toMatchObject({ asked: 0 });
    expect(calls).toHaveLength(1);
  });
});
