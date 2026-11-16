import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import {
  createFixtureTransport,
  loadFixture,
  type FixtureTransport,
} from "../../../fixture-transport";
import type { NormalizedBatch } from "../../../normalized";
import { ProviderShapeError } from "../../../transport";
import { chargebeeAdapter } from "..";

/**
 * B5 regression (docs/CONNECTOR-LIVE.md, Chargebee): the live site answers a list with
 * `next_offset` as a JSON ARRAY of two strings (e.g. ["1794861324000","2753"]), not a string. The
 * adapter's schema only allowed a string, so Test connection (GET /customers?limit=1) failed with
 * "Chargebee sent data in a shape we did not expect". Chargebee takes the cursor back as the JSON
 * text of that array; the bare comma form is refused (HTTP 400, "offset : wrong format").
 * `live-shape.json` is the site's real shape with every value replaced by a fictional one.
 */
const NOW = new Date("2026-11-16T12:00:00Z");
const world = () => createFixtureTransport(loadFixture("chargebee", "live-shape"));
const ctx = (t: FixtureTransport): AdapterContext<Record<string, never>> => ({
  workspaceId: "ws",
  integrationId: "int",
  credentials: { apiKey: "fixture-cb-key", site: "nexaworks-test" },
  config: {},
  transport: t,
  clock: () => NOW,
});
async function collect(t: FixtureTransport) {
  const out: NormalizedBatch[] = [];
  for await (const b of chargebeeAdapter.sync(ctx(t), { kind: "FULL" })) out.push(b);
  return out;
}

describe("Chargebee list cursors as the live site returns them", () => {
  it("accepts Test connection when next_offset is an array", async () => {
    const t = world();
    const r = await chargebeeAdapter.testConnection(ctx(t));
    expect(r.ok).toBe(true);
    expect(t.unmatched).toEqual([]);
  });

  it("validates a key when next_offset is an array", async () => {
    const t = world();
    await expect(
      chargebeeAdapter.auth.kind === "apiKey"
        ? chargebeeAdapter.auth.validate({ apiKey: "k", site: "nexaworks-test" }, t, {})
        : Promise.reject(new Error("not an API-key adapter")),
    ).resolves.toBeUndefined();
  });

  it("sends an array cursor back as its JSON text, and reads the next page", async () => {
    const t = world();
    const batches = await collect(t);
    expect(t.unmatched).toEqual([]);
    const customerCalls = t.calls.filter((c) => new URL(c.url).pathname.endsWith("/customers"));
    expect(customerCalls).toHaveLength(2);
    expect(new URL(customerCalls[1]!.url).searchParams.get("offset")).toBe(
      '["1794861324000","2753"]',
    );
    const customers = batches.filter((b) => b.kind === "customers").flatMap((b) => b.records);
    expect(customers.map((c) => (c as { externalId: string }).externalId)).toEqual([
      "cb_live_gamma",
      "cb_live_alpha",
      "cb_live_beta",
    ]);
  });

  it("maps the live subscription (quantity 4 at 9000 = 36000 minor) and invoice", async () => {
    const batches = await collect(world());
    const sub = batches.find((b) => b.kind === "subscriptions")!.records[0] as Record<
      string,
      unknown
    >;
    expect(sub).toMatchObject({
      externalId: "cb_live_sub",
      customerExternalId: "cb_live_gamma",
      plan: "proof-cb-monthly-USD-Monthly",
      interval: "MONTH",
      amountMinor: 36000,
      quantity: 4,
      status: "ACTIVE",
      currency: "USD",
    });
    const inv = batches.filter((b) => b.kind === "invoices").flatMap((b) => b.records)[0] as Record<
      string,
      unknown
    >;
    expect(inv).toMatchObject({
      externalId: "1",
      amountMinor: 36000,
      status: "OPEN",
      failureCount: 0,
    });
  });

  it("refuses a cursor that repeats instead of looping forever", async () => {
    const same = ["1794861324000", "9"];
    const t = createFixtureTransport([
      {
        request: { method: "GET", path: "/api/v2/customers" },
        response: { status: 200, headers: {}, body: { list: [], next_offset: same } },
      },
    ]);
    await expect(collect(t)).rejects.toBeInstanceOf(ProviderShapeError);
  });
});
