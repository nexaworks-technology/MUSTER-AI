import { createHmac } from "node:crypto";
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
 * Stripe end to end on the database, fixture transport only:
 *  - sync twice: the second run creates nothing (M5 rule 2);
 *  - a signed invoice.payment_failed opens a "Payment failed" Signal for the matched account
 *    within the same processing job (M5 §5, acceptance #6), with the invoice as evidence.
 */
vi.hoisted(() => {
  process.env.QUEUE_PREFIX = "nexaworks-stripe-test";
});
afterAll(() => closeQueues());

const SECRET = "whsec_test_stripe_int_only";
const NOW = new Date("2026-11-02T15:00:30Z");
const world = () =>
  createFixtureTransport(
    ["customers", "subscriptions", "invoices"].flatMap((f) => loadFixture("stripe", f)),
  );

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const sundial = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Sundial Fitness",
      domain: "sundial-fitness.test",
      tier: "LONG_TAIL",
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
      provider: "STRIPE",
      credentialsEnc: sealCredentials({ apiKey: "rk_test_fixture", webhookSecret: SECRET }),
    },
  });
  return { actor, db, sundial, integration };
}

describe("Stripe on the database (fixture transport)", () => {
  it("sync twice: the second run changes nothing", async () => {
    const S = await setup("StripeTwice");
    const payload = (runKey: string) => ({
      workspaceId: S.actor.workspaceId,
      integrationId: S.integration.id,
      kind: "FULL" as const,
      trigger: "MANUAL" as const,
      runKey,
    });
    const t1 = world();
    const first = await runSync(payload("one"), { transport: () => t1, clock: () => NOW });
    expect(first.status).toBe("SUCCEEDED");
    expect(first.counts).toMatchObject({
      created: 2 + 2 + 3, // customers linked, subscriptions, invoices
      unmatched: 2, // the unknown gym's customer and its invoice
      rejected: 1, // the weekly subscription
      archived: 1, // the deleted customer
    });
    const snapshot = async () => ({
      invoices: await S.db.invoice.count(),
      subscriptions: await S.db.subscription.count(),
      refs: await S.db.externalRef.count(),
      accounts: await S.db.account.count(),
    });
    const after1 = await snapshot();
    expect(after1).toEqual({ invoices: 3, subscriptions: 2, refs: 7, accounts: 2 });

    const t2 = world();
    const second = await runSync(payload("two"), { transport: () => t2, clock: () => NOW });
    expect(second.counts).toMatchObject({ created: 0, updated: 0 });
    expect(await snapshot()).toEqual(after1);
    const failed = await S.db.invoice.findFirstOrThrow({ where: { number: "SUNDIAL-0010" } });
    expect(failed).toMatchObject({
      accountId: S.sundial.id,
      status: "FAILED",
      failureCount: 2,
      source: "STRIPE",
    });
    const job = await S.db.syncJob.findUniqueOrThrow({ where: { id: second.syncJobId! } });
    expect(JSON.stringify(job.counts)).toContain("matches no account by domain or contact email");
  });

  it("a signed invoice.payment_failed opens a Payment failed signal for the matched account in the same job", async () => {
    const S = await setup("StripeRealtime");
    const raw = readFileSync(
      path.join(import.meta.dirname, "..", "__fixtures__", "webhook-invoice-payment-failed.json"),
      "utf8",
    );
    const t = Math.floor(NOW.getTime() / 1000);
    const header = `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex")}`;
    const objects = new Map<string, string>();
    const queued: string[] = [];
    const deps: WebhookDeps = {
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
    const res = await receiveWebhook(
      "STRIPE",
      S.integration.id,
      { headers: { "stripe-signature": header }, rawBody: raw, url: "https://app.test/hook" },
      deps,
    );
    expect(res.status).toBe(202);
    const result = await processWebhookEvent(
      { workspaceId: S.actor.workspaceId, webhookEventId: queued[0]! },
      deps,
    );
    expect(result).toMatchObject({ status: "PROCESSED", accountIds: [S.sundial.id] });
    expect(result.signalsOpened).toBeGreaterThanOrEqual(1);
    const invoice = await S.db.invoice.findFirstOrThrow({ where: { number: "SUNDIAL-0011" } });
    const signal = await S.db.signal.findFirstOrThrow({
      where: { accountId: S.sundial.id, dedupeKey: `payment_failed:${S.sundial.id}:${invoice.id}` },
    });
    expect(signal).toMatchObject({ status: "OPEN", title: "Payment failed: invoice SUNDIAL-0011" });
    expect(JSON.stringify(signal.evidence)).toContain(invoice.id);

    // A forged copy of the same event is refused and changes nothing.
    const forged = await receiveWebhook(
      "STRIPE",
      S.integration.id,
      { headers: { "stripe-signature": `t=${t},v1=${"a".repeat(64)}` }, rawBody: raw, url: "u" },
      deps,
    );
    expect(forged.status).toBe(401);
    expect(await S.db.webhookEvent.count()).toBe(1);
  });
});
