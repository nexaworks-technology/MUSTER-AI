import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import {
  createFixtureTransport,
  loadFixture,
  type FixtureTransport,
} from "../../../fixture-transport";
import type { NormalizedBatch } from "../../../normalized";
import { ProviderHttpError, ProviderShapeError } from "../../../transport";
import { amplitudeAdapter } from "..";

/** Amplitude contract: segmentation by account, the feature mapping, the folding, the errors. */
const TODAY = new Date("2026-11-02T15:00:00Z");
type Cfg = Parameters<typeof amplitudeAdapter.sync>[0]["config"];
const world = (...names: string[]) =>
  createFixtureTransport(names.flatMap((f) => loadFixture("amplitude", f)));
const ctx = (t: FixtureTransport, config: Partial<Cfg> = {}): AdapterContext<Cfg> => ({
  workspaceId: "ws",
  integrationId: "int",
  credentials: { username: "test-fixture-key", apiKey: "test_fixture_am_secret" },
  config: amplitudeAdapter.configSchema.parse({
    features: { dashboards: "Dashboard Viewed", data_connectors: "Data Connector Added" },
    ...config,
  }),
  transport: t,
  clock: () => new Date("2030-01-01T00:00:00Z"),
  businessClock: () => TODAY,
});
async function collect(
  t: FixtureTransport,
  opts: { kind: "FULL" | "INCREMENTAL"; cursor?: string } = { kind: "FULL" },
  config: Partial<Cfg> = {},
) {
  const out: NormalizedBatch[] = [];
  for await (const b of amplitudeAdapter.sync(ctx(t, config), opts)) out.push(b);
  return out;
}
const records = (b: NormalizedBatch[]) =>
  b.flatMap((x) => x.records) as Array<Record<string, unknown>>;

describe("Amplitude contract", () => {
  it("asks for daily segmentation grouped by the account property, with Basic auth", async () => {
    const t = world("segmentation");
    await collect(t);
    expect(t.unmatched).toEqual([]);
    // _active, _all, session, then uniques + totals for each of two features.
    expect(t.calls).toHaveLength(3 + 2 * 2);
    const u = new URL(t.calls[0]!.url);
    expect(u.host).toBe("amplitude.com");
    expect(u.searchParams.get("g")).toBe("gp:account_id");
    expect(u.searchParams.get("i")).toBe("1");
    expect(u.searchParams.get("start")).toBe("20260805");
    expect(u.searchParams.get("end")).toBe("20261102");
    expect(t.calls[0]!.headers!.authorization).toBe(
      `Basic ${Buffer.from("test-fixture-key:test_fixture_am_secret").toString("base64")}`,
    );
  });

  it("uses the EU host for an EU project", async () => {
    const t = world("segmentation");
    await collect(t, { kind: "INCREMENTAL", cursor: "2026-11-01" }, { region: "EU" });
    expect(new URL(t.calls[0]!.url).host).toBe("analytics.eu.amplitude.com");
  });

  it("writes one SET day per account with activity, none for quiet days or '(none)'", async () => {
    const out = records(await collect(world("segmentation")));
    expect(out.map((r) => `${r.accountExternalId} ${r.date}`)).toEqual([
      "pinecrest-health.test 2026-10-29",
      "pinecrest-health.test 2026-10-30",
      "pinecrest-health.test 2026-11-02",
      "unknown-co.test 2026-10-30",
    ]);
    expect(out[0]).toMatchObject({
      mode: "SET",
      events: 3,
      sessions: 1,
      activeUsers: 2,
      users: [],
      features: [
        { featureKey: "dashboards", users: 1, events: 1 },
        { featureKey: "data_connectors", users: 1, events: 1 },
      ],
    });
    expect(out[1]).toMatchObject({
      features: [{ featureKey: "dashboards", users: 2, events: 2 }],
    });
  });

  it("INCREMENTAL starts two days before the cursor and ends with a new cursor", async () => {
    const t = world("segmentation");
    const batches = await collect(t, { kind: "INCREMENTAL", cursor: "2026-10-30" });
    expect(new URL(t.calls[0]!.url).searchParams.get("start")).toBe("20261028");
    expect(batches.at(-1)).toMatchObject({ records: [], cursor: "2026-11-02" });
  });

  it("reads no feature events unless the workspace mapped some", async () => {
    const t = world("segmentation");
    const out = records(await collect(t, { kind: "FULL" }, { features: {} }));
    expect(t.calls).toHaveLength(3);
    expect(out.every((r) => (r.features as unknown[]).length === 0)).toBe(true);
  });

  it("explains a refused key, a rate limit and an unexpected body in plain words", async () => {
    const rate = await collect(world("error-429")).catch((e) => e);
    expect(rate).toBeInstanceOf(ProviderHttpError);
    expect(amplitudeAdapter.describeError(rate).plain).toContain("slow down");
    const t = createFixtureTransport([
      {
        request: { method: "GET", path: "/api/2/events/segmentation" },
        response: { status: 200, headers: {}, body: { data: { series: "x" } } },
      },
    ]);
    const bad = await collect(t).catch((e) => e);
    expect(bad).toBeInstanceOf(ProviderShapeError);
    expect(amplitudeAdapter.describeError(new ProviderHttpError(401))).toMatchObject({
      plain: "Amplitude rejected the saved credentials.",
      action: expect.stringContaining("API key"),
    });
  });

  it("the rejected demo key is refused by the recorded world", async () => {
    const t = createFixtureTransport(loadFixture("amplitude", "auth-rejected"));
    await expect(
      amplitudeAdapter.auth.kind === "apiKey" &&
        amplitudeAdapter.auth.validate(
          { username: "rejected-key-demo", apiKey: "am_rejected_secret_for_demo" },
          t,
        ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
