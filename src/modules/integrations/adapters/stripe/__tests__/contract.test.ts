import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import {
  createFixtureTransport,
  loadFixture,
  type FixtureTransport,
} from "../../../fixture-transport";
import type { NormalizedBatch } from "../../../normalized";
import { ProviderHttpError } from "../../../transport";
import { stripeAdapter, verifyStripeSignature } from "..";

/** Stripe contract: recorded payloads → normalized records, errors in plain words, signatures. */
const NOW = new Date("2026-11-02T15:00:30Z");
const SECRET = "whsec_test_contract_only";

function ctx(t: FixtureTransport): AdapterContext<Record<string, never>> {
  return {
    workspaceId: "ws",
    integrationId: "int",
    credentials: { apiKey: "rk_test_fixture" },
    config: {},
    transport: t,
    clock: () => NOW,
  };
}

const world = () =>
  createFixtureTransport(
    ["customers", "subscriptions", "invoices"].flatMap((f) => loadFixture("stripe", f)),
  );

async function collect(t: FixtureTransport) {
  const out: NormalizedBatch[] = [];
  for await (const b of stripeAdapter.sync(ctx(t), { kind: "FULL" })) out.push(b);
  return out;
}

const webhookBody = (name: string) =>
  readFileSync(path.join(import.meta.dirname, "..", "__fixtures__", `${name}.json`), "utf8");

describe("Stripe contract", () => {
  it("pages customers with starting_after and sends the key only as a bearer header", async () => {
    const t = world();
    const batches = await collect(t);
    expect(t.unmatched).toEqual([]);
    const customerCalls = t.calls.filter((c) => c.url.includes("/v1/customers"));
    expect(customerCalls.map((c) => new URL(c.url).searchParams.get("starting_after"))).toEqual([
      null,
      "cus_orchard",
    ]);
    expect(t.calls.every((c) => c.headers?.authorization === "Bearer rk_test_fixture")).toBe(true);
    expect(t.calls.every((c) => !c.url.includes("rk_test"))).toBe(true);
    const customers = batches.filter((b) => b.kind === "customers").flatMap((b) => b.records);
    expect(customers).toEqual([
      {
        externalId: "cus_sundial",
        email: "billing@sundial-fitness.test",
        name: "Sundial Fitness",
        deleted: false,
      },
      {
        externalId: "cus_orchard",
        email: "ap@orchard-lane.test",
        name: "Orchard Lane Bakery Supply",
        deleted: false,
      },
      {
        externalId: "cus_unknowngym",
        email: "ops@unknown-gym.test",
        name: "Unknown Gym",
        deleted: false,
      },
      { externalId: "cus_gone", email: undefined, name: undefined, deleted: true },
    ]);
  });

  it("maps subscriptions (status, interval, amount in minor units); an unsupported interval passes through for ingest to reject", async () => {
    const subs = (await collect(world()))
      .filter((b) => b.kind === "subscriptions")
      .flatMap((b) => b.records);
    expect(subs).toEqual([
      expect.objectContaining({
        externalId: "sub_sundial",
        interval: "MONTH",
        amountMinor: 20000,
        status: "ACTIVE",
        currency: "usd",
        plan: "Starter monthly",
        currentPeriodEnd: "2026-11-28T00:00:00.000Z",
      }),
      expect.objectContaining({ externalId: "sub_orchard", interval: "YEAR", status: "PAST_DUE" }),
      expect.objectContaining({ externalId: "sub_weekly", interval: "week" }),
    ]);
  });

  it("maps invoices: paid, failed with the failed charge's real time, open; drafts skipped; cursor last", async () => {
    const batches = await collect(world());
    const invoices = batches.filter((b) => b.kind === "invoices").flatMap((b) => b.records);
    expect(invoices.map((i) => (i as { externalId: string }).externalId)).toEqual([
      "in_sundial_oct",
      "in_sundial_nov",
      "in_orchard_1",
      "in_unknowngym",
    ]);
    expect(invoices[1]).toMatchObject({
      status: "FAILED",
      failureCount: 2,
      lastFailedAt: "2026-10-30T09:00:00.000Z",
      number: "SUNDIAL-0010",
      dueAt: "2026-10-28T00:00:00.000Z",
    });
    expect(invoices[0]).toMatchObject({
      status: "PAID",
      paidAt: "2026-09-28T01:00:00.000Z",
      lastFailedAt: undefined,
    });
    expect(invoices[2]).toMatchObject({ status: "OPEN", failureCount: 0 });
    expect(batches.at(-1)).toEqual({
      kind: "invoices",
      records: [],
      cursor: String(NOW.getTime() / 1000),
    });
  });

  it.each([
    [
      "error-401",
      401,
      "Stripe rejected the saved credentials.",
      "Paste a new restricted read-only key.",
    ],
    [
      "error-403",
      403,
      "Stripe refused access: the connection is missing a permission it needs.",
      undefined,
    ],
    [
      "error-429",
      429,
      "Stripe asked us to slow down (rate limit); it will accept requests again in about 30 seconds.",
      undefined,
    ],
    ["error-500", 500, "Stripe had a problem on its side (HTTP 500).", undefined],
  ])("%s → plain words", async (fixture, status, plain, action) => {
    const t = createFixtureTransport(loadFixture("stripe", fixture));
    const err = await collect(t).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(status);
    const d = stripeAdapter.describeError(err);
    expect(d.plain).toBe(plain);
    if (action) expect(d.action).toBe(action);
    expect(JSON.stringify(d)).not.toContain("rk_test");
  });

  it("validates a key with one cheap read", async () => {
    const t = world();
    const auth = stripeAdapter.auth;
    if (auth.kind !== "apiKey") throw new Error("Stripe connects with a key");
    await auth.validate({ apiKey: "rk_test_fixture" }, t);
    expect(t.calls.map((c) => new URL(c.url).search)).toEqual(["?limit=1"]);
  });
});

describe("Stripe webhook signature (forged-signature test, M5 rule 4)", () => {
  const raw = webhookBody("webhook-invoice-payment-failed");
  const t = Math.floor(NOW.getTime() / 1000);
  const sig = (secret: string, ts = t, body = raw) =>
    createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

  it("accepts Stripe's scheme with this integration's secret", () => {
    expect(verifyStripeSignature(raw, `t=${t},v1=${sig(SECRET)}`, SECRET, NOW)).toBe(true);
    expect(
      verifyStripeSignature(raw, `t=${t},v1=${"0".repeat(64)},v1=${sig(SECRET)}`, SECRET, NOW),
    ).toBe(true);
  });

  it.each([
    ["a forged signature", () => `t=${t},v1=${sig("whsec_attacker")}`],
    [
      "a signature over a different body",
      () => `t=${t},v1=${sig(SECRET, t, raw.replace("20000", "1"))}`,
    ],
    ["a stale timestamp (replay after 5 minutes)", () => `t=${t - 301},v1=${sig(SECRET, t - 301)}`],
    ["no v1 part", () => `t=${t}`],
    ["garbage", () => "nonsense"],
  ])("refuses %s", (_l, header) => {
    expect(verifyStripeSignature(raw, header(), SECRET, NOW)).toBe(false);
  });

  it("refuses a missing header", () => {
    expect(verifyStripeSignature(raw, undefined, SECRET, NOW)).toBe(false);
  });

  it("turns invoice.payment_failed into a customer + FAILED invoice dated by the event, flagged for real time", () => {
    const [e] = stripeAdapter.webhook!.toEvents(JSON.parse(raw));
    expect(e).toMatchObject({
      externalEventId: "evt_sundial_failed_1",
      type: "invoice.payment_failed",
      realtimeCustomerExternalId: "cus_sundial",
    });
    expect(e!.batches[0]).toEqual({
      kind: "customers",
      records: [
        {
          externalId: "cus_sundial",
          email: "billing@sundial-fitness.test",
          name: "Sundial Fitness",
        },
      ],
    });
    expect(e!.batches[1]!.records[0]).toMatchObject({
      externalId: "in_sundial_dec",
      status: "FAILED",
      failureCount: 1,
      lastFailedAt: "2026-11-02T15:00:00.000Z",
    });
  });

  it("ignores event types it does not handle", () => {
    expect(
      stripeAdapter.webhook!.toEvents({
        id: "evt_x",
        type: "charge.refunded",
        created: 1,
        data: { object: {} },
      }),
    ).toEqual([]);
    expect(stripeAdapter.webhook!.toEvents({ not: "an event" })).toEqual([]);
  });
});
