import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import {
  considerHealthNarrative,
  needsNarrative,
  sweepHealthNarratives,
} from "../definitions/health-analyst-trigger";
import { healthNarrative } from "../narrative";

/**
 * Health Analyst (M4 §2, founder point 8): it runs on a band change, a top-reason change or a
 * first snapshot that is not Healthy, once per snapshot, and the Health tab shows only what a
 * SUCCEEDED run cited, linked to the exact reasons. A fake provider stands in for the model.
 */
const reason = (component: string, impact: number) => ({
  kind: "EVIDENCE",
  impact,
  component,
  input: "i",
});

describe("needsNarrative", () => {
  const snap = (riskLevel: string, reasons = [reason("users", -6.9)]) => ({
    id: "s",
    riskLevel,
    reasons,
  });
  it("first snapshot: only when it is not Healthy", () => {
    expect(needsNarrative(snap("WATCH"), null)).toBe("first snapshot is not Healthy");
    expect(needsNarrative(snap("HEALTHY"), null)).toBeNull();
  });
  it("a band change triggers", () => {
    expect(needsNarrative(snap("AT_RISK"), snap("WATCH"))).toBe("band changed WATCH → AT_RISK");
  });
  it("a new top reason triggers; the same one does not", () => {
    expect(needsNarrative(snap("WATCH", [reason("champion", -9)]), snap("WATCH"))).toBe(
      "top reason changed",
    );
    expect(needsNarrative(snap("WATCH"), snap("WATCH"))).toBeNull();
  });
});

async function account(db: ScopedDb, ws: string, level: "WATCH" | "HEALTHY") {
  const a = await db.account.create({
    data: { workspaceId: ws, name: `Acct ${randomUUID().slice(0, 4)}`, tier: "HIGH_TOUCH" },
  });
  const model =
    (await db.healthModel.findFirst({ where: { status: "ACTIVE" } })) ??
    (await db.healthModel.create({
      data: {
        workspaceId: ws,
        version: 1,
        status: "ACTIVE",
        proposedBy: "SYSTEM_DEFAULT",
        pillarWeights: {},
        componentConfig: {},
        thresholds: { healthyMin: 70, watchMin: 45 },
      },
    }));
  const snapshotId = randomUUID();
  const reasonId = randomUUID();
  await db.$tenantTransaction(async (tx) => {
    await tx.healthScoreSnapshot.create({
      data: {
        id: snapshotId,
        workspaceId: ws,
        accountId: a.id,
        healthModelId: model.id,
        asOf: new Date("2026-11-02"),
        overall: level === "WATCH" ? 67.6 : 95,
        adoption: level === "WATCH" ? 46 : 95,
        riskLevel: level,
        riskLevelExcludingPulse: level,
        effectiveWeights: {},
        inputsHash: snapshotId,
      },
    });
    await tx.healthReason.create({
      data: {
        id: reasonId,
        workspaceId: ws,
        snapshotId,
        pillar: "ADOPTION",
        component: "users",
        kind: "EVIDENCE",
        direction: "DOWN",
        impact: -6.9,
        input: "i",
        message:
          "Typical weekday active users fell from 40 to 20.4 (−49%) against this account's normal (Jul 21 – Oct 19, 2026)",
        sources: [{ sourceType: "Account", sourceId: a.id }],
      },
    });
    await tx.account.update({ where: { id: a.id }, data: { currentHealthSnapshotId: snapshotId } });
  });
  return { accountId: a.id, snapshotId, reasonId };
}

function provider(make: (bundleIds: string[]) => unknown) {
  const calls: StructuredRequest<unknown>[] = [];
  const p: AiProvider = {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      calls.push(req as StructuredRequest<unknown>);
      const ids = [...req.input.matchAll(/"sourceId": "([^"]+)"/g)].map((m) => m[1]!);
      return {
        output: make(ids) as T,
        stopReason: "end_turn",
        model: "model-from-env-standard",
        requestId: null,
        inputTokens: 10,
        outputTokens: 10,
        latencyMs: 1,
      };
    },
  };
  return { p, calls };
}

describe("Health Analyst runs", () => {
  it("runs once for a first Watch snapshot; the narrative links each item to its reason", async () => {
    const { actor } = await createTestAdmin("HAWatch");
    const db = scopedDb(actor);
    const { accountId, snapshotId, reasonId } = await account(db, actor.workspaceId, "WATCH");
    const { p, calls } = provider(() => ({
      reasoningSummary: "Usage has roughly halved against normal.",
      confidence: 0.7,
      citations: [
        { sourceType: "HealthScoreSnapshot", sourceId: snapshotId },
        { sourceType: "HealthReason", sourceId: reasonId, quote: "fell from 40 to 20.4" },
      ],
      proposedActions: [],
      items: [
        {
          text: "Weekday users fell from 40 to 20.4 (−49%).",
          citesReasonIds: [reasonId],
          citesSignalIds: [],
        },
      ],
    }));
    const first = await considerHealthNarrative(actor, accountId, { provider: p });
    expect(first).toMatchObject({
      ran: true,
      why: "first snapshot is not Healthy",
      outcome: { status: "SUCCEEDED" },
    });
    // The outbox event and the sweep may both fire: still one run, one model call.
    await considerHealthNarrative(actor, accountId, { provider: p });
    expect(await sweepHealthNarratives(actor, { provider: p })).toEqual({ considered: 0, ran: 0 });
    expect(calls).toHaveLength(1);
    expect(await db.agentRun.count({ where: { agentKey: "health-analyst" } })).toBe(1);
    const n = await healthNarrative(actor, accountId);
    expect(n.run).toMatchObject({
      status: "SUCCEEDED",
      promptVersion: "1.0.0",
      model: "model-from-env-standard",
    });
    expect(n.items).toEqual([
      {
        text: "Weekday users fell from 40 to 20.4 (−49%).",
        sources: [
          expect.objectContaining({
            href: `/accounts/${accountId}/health?reason=${reasonId}#reason-${reasonId}`,
            missing: false,
          }),
        ],
      },
    ]);
  });

  it("a healthy first snapshot needs no narrative and calls no model", async () => {
    const { actor } = await createTestAdmin("HAHealthy");
    const db = scopedDb(actor);
    const { accountId } = await account(db, actor.workspaceId, "HEALTHY");
    const { p, calls } = provider(() => ({}));
    expect(await considerHealthNarrative(actor, accountId, { provider: p })).toMatchObject({
      ran: false,
    });
    expect(calls).toHaveLength(0);
  });

  it("an uncited answer is stored as UNCITED and the Health tab shows nothing from it", async () => {
    const { actor } = await createTestAdmin("HAUncited");
    const db = scopedDb(actor);
    const { accountId, snapshotId } = await account(db, actor.workspaceId, "WATCH");
    const { p } = provider(() => ({
      reasoningSummary: "r",
      confidence: 0.5,
      citations: [{ sourceType: "HealthScoreSnapshot", sourceId: snapshotId }],
      proposedActions: [],
      items: [
        {
          text: "Usage fell 70% this quarter.",
          citesReasonIds: ["not-a-reason"],
          citesSignalIds: [],
        },
      ],
    }));
    expect(await considerHealthNarrative(actor, accountId, { provider: p })).toMatchObject({
      outcome: { status: "UNCITED" },
    });
    const n = await healthNarrative(actor, accountId);
    expect(n.run).toBeNull();
    expect(n.items).toEqual([]);
    expect(n.latestAttempt).toMatchObject({ status: "UNCITED" });
  });

  it("with no API key nothing runs and the tab says AI is not configured", async () => {
    const { actor } = await createTestAdmin("HANoKey");
    const db = scopedDb(actor);
    const { accountId } = await account(db, actor.workspaceId, "WATCH");
    expect(await considerHealthNarrative(actor, accountId)).toMatchObject({
      ran: true,
      outcome: { kind: "not_configured" },
    });
    expect(await db.agentRun.count()).toBe(0);
    expect(await healthNarrative(actor, accountId)).toMatchObject({
      configured: false,
      run: null,
      items: [],
    });
  });

  it("shows a narrative only about the snapshot the Health tab shows, never an older one", async () => {
    const { actor } = await createTestAdmin("HAStale");
    const db = scopedDb(actor);
    const first = await account(db, actor.workspaceId, "WATCH");
    const { p } = provider(() => ({
      reasoningSummary: "Usage has roughly halved.",
      confidence: 0.7,
      citations: [{ sourceType: "HealthScoreSnapshot", sourceId: first.snapshotId }],
      proposedActions: [],
      items: [
        {
          text: "Weekday users fell from 40 to 20.4.",
          citesReasonIds: [first.reasonId],
          citesSignalIds: [],
        },
      ],
    }));
    await considerHealthNarrative(actor, first.accountId, { provider: p });
    expect((await healthNarrative(actor, first.accountId)).items).toHaveLength(1);
    // A newer snapshot under the active model replaces what the tab shows.
    const model = await db.healthModel.findFirstOrThrow({ where: { status: "ACTIVE" } });
    const newer = randomUUID();
    await db.$tenantTransaction(async (tx) => {
      await tx.healthScoreSnapshot.create({
        data: {
          id: newer,
          workspaceId: actor.workspaceId,
          accountId: first.accountId,
          healthModelId: model.id,
          asOf: new Date("2026-11-03"),
          overall: 95,
          adoption: 95,
          riskLevel: "HEALTHY",
          riskLevelExcludingPulse: "HEALTHY",
          effectiveWeights: {},
          inputsHash: newer,
        },
      });
      await tx.healthReason.create({
        data: {
          workspaceId: actor.workspaceId,
          snapshotId: newer,
          pillar: "ADOPTION",
          component: "users",
          kind: "EVIDENCE",
          direction: "UP",
          impact: 0,
          input: "i",
          message: "Usage is at normal.",
          sources: [{ sourceType: "Account", sourceId: first.accountId }],
        },
      });
    });
    const n = await healthNarrative(actor, first.accountId);
    expect(n.run).toBeNull();
    expect(n.items).toEqual([]);
  });
});
