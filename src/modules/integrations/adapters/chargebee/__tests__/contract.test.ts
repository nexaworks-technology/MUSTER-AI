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
import type { ProviderHttpError } from "../../../transport";
import { chargebeeAdapter, verifyChargebeeBasicAuth } from "..";

/** Chargebee contract: next_offset paging, statuses, dunning dates, errors, Basic-auth webhooks. */
const NOW = new Date("2026-11-02T15:00:00Z");
const world = () =>
  createFixtureTransport(
    ["customers", "subscriptions", "invoices"].flatMap((f) => loadFixture("chargebee", f)),
  );
const ctx = (t: FixtureTransport): AdapterContext<Record<string, never>> => ({
  workspaceId: "ws",
  integrationId: "int",
  credentials: { apiKey: "test_fixture_cb_key", site: "larkspur-test" },
  config: {},
  transport: t,
  clock: () => NOW,
});
async function collect(
  t: FixtureTransport,
  kind: "FULL" | "INCREMENTAL" = "FULL",
  cursor?: string,
) {
  const out: NormalizedBatch[] = [];
  for await (const b of chargebeeAdapter.sync(ctx(t), { kind, cursor })) out.push(b);
  return out;
}
const of = (b: NormalizedBatch[], kind: NormalizedBatch["kind"]) =>
  b.filter((x) => x.kind === kind).flatMap((x) => x.records) as Array<Record<string, unknown>>;

describe("Chargebee contract", () => {
  it("pages with next_offset on the site's host and sends the key as Basic auth", async () => {
    const t = world();
    const batches = await collect(t);
    expect(t.unmatched).toEqual([]);
    expect(t.calls.every((c) => new URL(c.url).host === "larkspur-test.chargebee.com")).toBe(true);
    expect(t.calls[0]!.headers!.authorization).toBe(
      `Basic ${Buffer.from("test_fixture_cb_key:").toString("base64")}`,
    );
    expect(new URL(t.calls[1]!.url).searchParams.get("offset")).toBe('["1793000000000","2"]');
    expect(of(batches, "customers")).toEqual([
      {
        externalId: "cb_orchard",
        email: "ap@orchard-lane.test",
        name: "Orchard Lane Bakery Supply",
        deleted: false,
      },
      {
        externalId: "cb_kestrel",
        email: "billing@kestrel-robotics.test",
        name: "Kestrel Robotics",
        deleted: false,
      },
      { externalId: "cb_nomatch", email: "ap@lost-cafe.test", name: "Lost Cafe", deleted: false },
      { externalId: "cb_gone", email: "x@gone.test", name: "Gone", deleted: true },
    ]);
  });

  it("maps subscriptions and invoices: dunning attempts date a failure; pending skipped", async () => {
    const batches = await collect(world());
    expect(of(batches, "subscriptions")).toEqual([
      expect.objectContaining({
        externalId: "sub_kestrel",
        interval: "MONTH",
        amountMinor: 150000,
        status: "ACTIVE",
      }),
      expect.objectContaining({ externalId: "sub_orchard_cb", interval: "YEAR", status: "ACTIVE" }),
    ]);
    const invoices = of(batches, "invoices");
    expect(invoices.map((i) => i.externalId)).toEqual(["cb-inv-101", "cb-inv-102"]);
    expect(invoices[0]).toMatchObject({ status: "PAID", paidAt: "2026-10-01T02:00:00.000Z" });
    expect(invoices[1]).toMatchObject({
      status: "FAILED",
      failureCount: 2,
      lastFailedAt: "2026-11-01T09:00:00.000Z",
    });
    expect(batches.at(-1)?.cursor).toBe(String(NOW.getTime() / 1000));
  });

  it("INCREMENTAL asks for updated_at[after] the cursor", async () => {
    const t = world();
    await collect(t, "INCREMENTAL", "1793000000");
    expect(
      t.calls.every((c) => new URL(c.url).searchParams.get("updated_at[after]") === "1793000000"),
    ).toBe(true);
  });

  it.each([
    ["error-401", 401, "The API key was rejected by Chargebee.", "Paste a new read-only key."],
    [
      "error-403",
      403,
      "Chargebee refused access: the connection is missing a permission it needs.",
      undefined,
    ],
    [
      "error-429",
      429,
      "Chargebee asked us to slow down (rate limit); it will accept requests again in about 20 seconds.",
      undefined,
    ],
    ["error-500", 500, "Chargebee had a problem on its side (HTTP 500).", undefined],
  ])("%s → plain words", async (fixture, status, plain, action) => {
    const err = await collect(createFixtureTransport(loadFixture("chargebee", fixture))).catch(
      (e: unknown) => e,
    );
    expect((err as ProviderHttpError).status).toBe(status);
    const d = chargebeeAdapter.describeError(err);
    expect(d.plain).toBe(plain);
    if (action) expect(d.action).toBe(action);
  });
});

describe("Chargebee webhook Basic auth (forged-credentials test, M5 rule 4, D3)", () => {
  const secret = "larkspur-hook:test-only-hook-password";
  const basic = (v: string) => `Basic ${Buffer.from(v).toString("base64")}`;

  it("accepts exactly this integration's stored credentials", () => {
    expect(verifyChargebeeBasicAuth(basic(secret), secret)).toBe(true);
  });

  it.each([
    ["forged credentials", basic("larkspur-hook:guessed-password")],
    ["another integration's credentials", basic("other-hook:other-password")],
    ["the right password with no user", basic(":test-only-hook-password")],
    ["a bearer token instead", "Bearer whatever"],
    ["garbage", "Basic !!!"],
  ])("refuses %s", (_l, header) => {
    expect(verifyChargebeeBasicAuth(header, secret)).toBe(false);
  });

  it("refuses a missing header", () => {
    expect(verifyChargebeeBasicAuth(undefined, secret)).toBe(false);
  });

  it("payment_failed becomes customer + FAILED invoice dated by the event, flagged for real time", () => {
    const raw = readFileSync(
      path.join(import.meta.dirname, "..", "__fixtures__", "webhook-payment-failed.json"),
      "utf8",
    );
    const [e] = chargebeeAdapter.webhook!.toEvents(JSON.parse(raw));
    expect(e).toMatchObject({
      externalEventId: "ev_kestrel_failed_1",
      realtimeCustomerExternalId: "cb_kestrel",
    });
    expect(e!.batches[1]!.records[0]).toMatchObject({
      externalId: "cb-inv-104",
      status: "FAILED",
      lastFailedAt: "2026-11-02T14:30:00.000Z",
    });
    expect(
      chargebeeAdapter.webhook!.toEvents({
        id: "x",
        occurred_at: 1,
        event_type: "customer_created",
        content: {},
      }),
    ).toEqual([]);
  });
});
