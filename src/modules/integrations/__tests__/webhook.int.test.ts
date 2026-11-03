import { createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import type { IntegrationAdapter } from "../adapter";
import { sealCredentials } from "../credentials";
import { describeProviderError } from "../errors";
import { processWebhookEvent, receiveWebhook, type WebhookDeps } from "../webhooks.service";

/**
 * M5 §5 webhook tests (framework part): unverified payloads are refused with 401 and store
 * nothing; a replayed event id is a no-op; A's webhook URL with a payload signed by B's secret
 * fails (tenant suite item); processing ingests once. The Stripe payment-failed signal test is
 * with the Stripe adapter (stripe-webhook.int.test.ts).
 */
const sign = (secret: string, body: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

const fakeAdapter: IntegrationAdapter<Record<string, never>> = {
  provider: "STRIPE",
  category: "BILLING",
  displayName: "Fake billing",
  configSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
  auth: { kind: "apiKey", validate: async () => {} },
  testConnection: async () => ({ ok: true, message: "ok" }),
  async *sync() {},
  webhook: {
    verify(req, secret) {
      const got = Buffer.from(req.headers["x-fake-signature"] ?? "");
      const want = Buffer.from(sign(secret, req.rawBody));
      return got.length === want.length && timingSafeEqual(got, want);
    },
    toEvents(payload) {
      const p = z
        .object({
          id: z.string(),
          type: z.string(),
          customer: z.object({ id: z.string(), email: z.string() }),
        })
        .parse(payload);
      return [
        {
          externalEventId: p.id,
          type: p.type,
          batches: [
            {
              kind: "customers",
              records: [{ externalId: p.customer.id, email: p.customer.email }],
            },
          ],
        },
      ];
    },
  },
  describeError: (e) => describeProviderError(e, "Fake", "Reconnect."),
};

function memoryDeps() {
  const objects = new Map<string, string>();
  const enqueued: string[] = [];
  const deps: WebhookDeps = {
    adapter: () => fakeAdapter as IntegrationAdapter<unknown>,
    storage: {
      ensureBucket: async () => {},
      put: vi.fn(async (ctx, segments, body) => {
        const key = ["ws", ctx.workspaceId, ...segments].join("/");
        objects.set(key, String(body));
        return { key };
      }),
      get: async (ctx, segments) =>
        new TextEncoder().encode(objects.get(["ws", ctx.workspaceId, ...segments].join("/"))),
    },
    enqueue: async (id) => void enqueued.push(id),
  };
  return { deps, objects, enqueued };
}

async function setup(label: string, secret: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  await db.account.create({
    data: {
      workspaceId: actor.workspaceId,
      name: `${label} Co`,
      domain: `${label.toLowerCase()}.example`,
      tier: "MID_TOUCH",
    },
  });
  const integration = await db.integration.create({
    data: {
      workspaceId: actor.workspaceId,
      provider: "STRIPE",
      credentialsEnc: sealCredentials({ apiKey: "rk_test_x", webhookSecret: secret }),
    },
  });
  return { actor, db, integration };
}

const body = (id: string, email: string) =>
  JSON.stringify({ id, type: "customer.updated", customer: { id: "cus_1", email } });

describe("webhook intake (M5 rule 4)", () => {
  it("an invalid signature returns 401 and stores nothing", async () => {
    const S = await setup("WhBadSig", "whsec_test_aaaaaaaa");
    const m = memoryDeps();
    const raw = body("evt_1", "x@whbadsig.example");
    const res = await receiveWebhook(
      "STRIPE",
      S.integration.id,
      {
        headers: { "x-fake-signature": sign("whsec_wrong_secret", raw) },
        rawBody: raw,
        url: "https://app.test/x",
      },
      m.deps,
    );
    expect(res).toEqual({ status: 401, body: "unverified" });
    expect(m.deps.storage!.put).not.toHaveBeenCalled();
    expect(await S.db.webhookEvent.count()).toBe(0);
    expect(m.enqueued).toEqual([]);
  });

  it("unknown, wrong-provider and disconnected integrations get the same 401", async () => {
    const S = await setup("WhUnknown", "whsec_test_bbbbbbbb");
    const m = memoryDeps();
    const raw = body("evt_1", "x@whunknown.example");
    const req = {
      headers: { "x-fake-signature": sign("whsec_test_bbbbbbbb", raw) },
      rawBody: raw,
      url: "u",
    };
    expect((await receiveWebhook("STRIPE", "cnotarealintegrationid0000", req, m.deps)).status).toBe(
      401,
    );
    expect((await receiveWebhook("STRIPE", "../../etc", req, m.deps)).status).toBe(401);
    expect((await receiveWebhook("CHARGEBEE", S.integration.id, req, m.deps)).status).toBe(401);
    await S.db.integration.update({
      where: { id: S.integration.id },
      data: { status: "DISCONNECTED", credentialsEnc: null },
    });
    expect((await receiveWebhook("STRIPE", S.integration.id, req, m.deps)).status).toBe(401);
    expect(m.deps.storage!.put).not.toHaveBeenCalled();
  });

  it("workspace A's webhook URL with a payload signed by B's secret fails (tenant suite)", async () => {
    const A = await setup("WhTenantA", "whsec_test_A_secret");
    const B = await setup("WhTenantB", "whsec_test_B_secret");
    const m = memoryDeps();
    const raw = body("evt_cross", "x@whtenantb.example");
    const res = await receiveWebhook(
      "STRIPE",
      A.integration.id,
      { headers: { "x-fake-signature": sign("whsec_test_B_secret", raw) }, rawBody: raw, url: "u" },
      m.deps,
    );
    expect(res.status).toBe(401);
    expect(await A.db.webhookEvent.count()).toBe(0);
    expect(await B.db.webhookEvent.count()).toBe(0);
  });

  it("a verified event is stored once and queued once; replaying it is a no-op", async () => {
    const S = await setup("WhReplay", "whsec_test_cccccccc");
    const m = memoryDeps();
    const raw = body("evt_42", "billing@whreplay.example");
    const req = {
      headers: { "x-fake-signature": sign("whsec_test_cccccccc", raw) },
      rawBody: raw,
      url: "u",
    };
    expect(await receiveWebhook("STRIPE", S.integration.id, req, m.deps)).toEqual({
      status: 202,
      body: "accepted",
    });
    expect(await receiveWebhook("STRIPE", S.integration.id, req, m.deps)).toEqual({
      status: 200,
      body: "duplicate",
    });
    const rows = await S.db.webhookEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalEventId: "evt_42", status: "RECEIVED" });
    expect(rows[0]?.payloadStorageKey.startsWith(`ws/${S.actor.workspaceId}/webhooks/`)).toBe(true);
    expect(m.enqueued).toEqual([rows[0]!.id]);

    const p = { workspaceId: S.actor.workspaceId, webhookEventId: rows[0]!.id };
    const first = await processWebhookEvent(p, m.deps);
    expect(first.status).toBe("PROCESSED");
    expect(await S.db.externalRef.count({ where: { objectType: "Customer" } })).toBe(1);
    expect((await processWebhookEvent(p, m.deps)).status).toBe("SKIPPED");
    expect(await S.db.webhookEvent.findFirstOrThrow()).toMatchObject({ status: "PROCESSED" });
  });

  it("a verified body that is not JSON is refused without storing", async () => {
    const S = await setup("WhNotJson", "whsec_test_dddddddd");
    const m = memoryDeps();
    const raw = "not json";
    const res = await receiveWebhook(
      "STRIPE",
      S.integration.id,
      { headers: { "x-fake-signature": sign("whsec_test_dddddddd", raw) }, rawBody: raw, url: "u" },
      m.deps,
    );
    expect(res.status).toBe(400);
    expect(await S.db.webhookEvent.count()).toBe(0);
  });
});
