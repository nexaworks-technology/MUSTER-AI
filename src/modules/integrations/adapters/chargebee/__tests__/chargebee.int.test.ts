import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { closeQueues } from "@/lib/jobs/queues";
import { createTestAdmin } from "@/test/fixtures";
import { sealCredentials } from "../../../credentials";
import { createFixtureTransport, loadFixture } from "../../../fixture-transport";
import { runSync } from "../../../sync.jobs";
import { processWebhookEvent, receiveWebhook, type WebhookDeps } from "../../../webhooks.service";

/**
 * Chargebee on the database, fixture transport only: sync twice changes nothing (M5 rule 2);
 * a forged Basic-auth webhook is refused and stores nothing; the real credentials open a
 * Payment failed signal in the same job.
 */
vi.hoisted(() => {
  process.env.QUEUE_PREFIX = "nexaworks-chargebee-test";
});
afterAll(() => closeQueues());

const NOW = new Date("2026-11-02T15:00:00Z");
const HOOK = "larkspur-hook:test-only-hook-password";
const basic = (v: string) => `Basic ${Buffer.from(v).toString("base64")}`;

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const ws = actor.workspaceId;
  const db = scopedDb(actor);
  const kestrel = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Kestrel Robotics",
      domain: "kestrel-robotics.test",
      tier: "MID_TOUCH",
    },
  });
  await db.account.create({
    data: {
      workspaceId: ws,
      name: "Orchard Lane Bakery Supply",
      domain: "orchard-lane.test",
      tier: "LONG_TAIL",
    },
  });
  const integration = await db.integration.create({
    data: {
      workspaceId: ws,
      provider: "CHARGEBEE",
      credentialsEnc: sealCredentials({
        apiKey: "test_fixture_cb_key",
        site: "larkspur-test",
        webhookSecret: HOOK,
      }),
    },
  });
  return { actor, db, kestrel, integration };
}

function memory(): WebhookDeps & { queued: string[] } {
  const objects = new Map<string, string>();
  const queued: string[] = [];
  return {
    queued,
    clock: () => NOW,
    storage: {
      ensureBucket: async () => {},
      put: async (ctx, segments, body) => {
        const key = ["ws", ctx.workspaceId, ...segments].join("/");
        objects.set(key, String(body));
        return { key };
      },
      get: async (ctx, segments) =>
        new TextEncoder().encode(objects.get(["ws", ctx.workspaceId, ...segments].join("/"))),
    },
    enqueue: async (id) => void queued.push(id),
  };
}

describe("Chargebee on the database (fixture transport)", () => {
  it("sync twice: the second run changes nothing", async () => {
    const S = await setup("CbTwice");
    const world = () =>
      createFixtureTransport(
        ["customers", "subscriptions", "invoices"].flatMap((f) => loadFixture("chargebee", f)),
      );
    const p = (runKey: string) => ({
      workspaceId: S.actor.workspaceId,
      integrationId: S.integration.id,
      kind: "FULL" as const,
      trigger: "MANUAL" as const,
      runKey,
    });
    const first = await runSync(p("one"), { transport: world, clock: () => NOW });
    expect(first.counts).toMatchObject({ created: 2 + 2 + 2, unmatched: 1, archived: 1 });
    const snap = async () => [
      await S.db.invoice.count(),
      await S.db.subscription.count(),
      await S.db.externalRef.count(),
    ];
    const before = await snap();
    const second = await runSync(p("two"), { transport: world, clock: () => NOW });
    expect(second.counts).toMatchObject({ created: 0, updated: 0 });
    expect(await snap()).toEqual(before);
  });

  it("a forged Basic-auth webhook gets 401 and stores nothing; the real one opens the signal in the same job", async () => {
    const S = await setup("CbHook");
    const raw = readFileSync(
      path.join(import.meta.dirname, "..", "__fixtures__", "webhook-payment-failed.json"),
      "utf8",
    );
    const m = memory();
    const forged = await receiveWebhook(
      "CHARGEBEE",
      S.integration.id,
      { headers: { authorization: basic("larkspur-hook:guessed") }, rawBody: raw, url: "u" },
      m,
    );
    expect(forged).toEqual({ status: 401, body: "unverified" });
    expect(await S.db.webhookEvent.count()).toBe(0);
    expect(m.queued).toEqual([]);

    const ok = await receiveWebhook(
      "CHARGEBEE",
      S.integration.id,
      { headers: { authorization: basic(HOOK) }, rawBody: raw, url: "u" },
      m,
    );
    expect(ok.status).toBe(202);
    const r = await processWebhookEvent(
      { workspaceId: S.actor.workspaceId, webhookEventId: m.queued[0]! },
      m,
    );
    expect(r).toMatchObject({ status: "PROCESSED", accountIds: [S.kestrel.id] });
    const inv = await S.db.invoice.findFirstOrThrow({ where: { number: "cb-inv-104" } });
    expect(
      await S.db.signal.count({
        where: { dedupeKey: `payment_failed:${S.kestrel.id}:${inv.id}`, status: "OPEN" },
      }),
    ).toBe(1);
  });
});
