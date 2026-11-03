import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import {
  createFixtureTransport,
  loadFixture,
  type FixtureTransport,
} from "../../../fixture-transport";
import type { NormalizedBatch } from "../../../normalized";
import { ProviderHttpError, ProviderShapeError } from "../../../transport";
import { mixpanelAdapter } from "..";

/** Mixpanel contract: the export's shape, the week-by-week reads, the folding, the errors. */
const TODAY = new Date("2026-11-02T15:00:00Z");
type Cfg = Parameters<typeof mixpanelAdapter.sync>[0]["config"];
const world = (...names: string[]) =>
  createFixtureTransport(names.flatMap((f) => loadFixture("mixpanel", f)));
const ctx = (t: FixtureTransport, config: Partial<Cfg> = {}): AdapterContext<Cfg> => ({
  workspaceId: "ws",
  integrationId: "int",
  credentials: { username: "larkspur-sa.test", apiKey: "test_fixture_mp_secret" },
  config: mixpanelAdapter.configSchema.parse({ projectId: "3412345", ...config }),
  transport: t,
  clock: () => new Date("2030-01-01T00:00:00Z"), // wall clock: must not date the window
  businessClock: () => TODAY,
});
async function collect(
  t: FixtureTransport,
  opts: { kind: "FULL" | "INCREMENTAL"; cursor?: string } = { kind: "FULL" },
  config: Partial<Cfg> = {},
) {
  const out: NormalizedBatch[] = [];
  for await (const b of mixpanelAdapter.sync(ctx(t, config), opts)) out.push(b);
  return out;
}
const records = (b: NormalizedBatch[]) =>
  b.flatMap((x) => x.records) as Array<{
    accountExternalId: string;
    date: string;
    [k: string]: unknown;
  }>;

describe("Mixpanel contract", () => {
  it("reads the export a week at a time, dated by the business clock, with Basic auth", async () => {
    const t = world("export");
    await collect(t);
    expect(t.unmatched).toEqual([]);
    // 90 days ending 2026-11-02 in 7-day chunks.
    expect(t.calls).toHaveLength(13);
    const first = new URL(t.calls[0]!.url);
    expect(first.host).toBe("data.mixpanel.com");
    expect(first.searchParams.get("project_id")).toBe("3412345");
    expect(first.searchParams.get("from_date")).toBe("2026-08-05");
    expect(first.searchParams.get("to_date")).toBe("2026-08-11");
    const last = new URL(t.calls.at(-1)!.url);
    expect(last.searchParams.get("from_date")).toBe("2026-10-28");
    expect(last.searchParams.get("to_date")).toBe("2026-11-02");
    expect(t.calls[0]!.headers!.authorization).toBe(
      `Basic ${Buffer.from("larkspur-sa.test:test_fixture_mp_secret").toString("base64")}`,
    );
  });

  it("uses the EU host for an EU project", async () => {
    const t = world("export");
    await collect(t, { kind: "INCREMENTAL", cursor: "2026-11-01" }, { region: "EU" });
    expect(new URL(t.calls[0]!.url).host).toBe("data-eu.mixpanel.com");
  });

  it("folds events into one SET day per account, each event counted once across weeks", async () => {
    const batches = await collect(world("export"));
    const days = records(batches).map((r) => `${r.accountExternalId} ${r.date}`);
    expect(days).toEqual([
      "pinecrest-health.test 2026-10-29",
      "pinecrest-health.test 2026-10-30",
      "unknown-co.test 2026-10-30",
      "pinecrest-health.test 2026-11-02",
    ]);
    const pine29 = records(batches)[0]!;
    expect(pine29).toMatchObject({
      mode: "SET",
      events: 3,
      sessions: 1,
      activeUsers: 2,
      users: [
        { externalUserId: "u-pine-1", events: 2, sessions: 1 },
        { externalUserId: "u-pine-2", events: 1, sessions: 0 },
      ],
      features: [
        { featureKey: "dashboards", users: 1, events: 1 },
        { featureKey: "data_connectors", users: 1, events: 1 },
      ],
    });
    // The anonymous page view (no account) is nobody's usage and is left out.
    expect(records(batches).reduce((n, r) => n + (r.events as number), 0)).toBe(3 + 3 + 1 + 1);
  });

  it("INCREMENTAL re-reads the last two days from the cursor and ends with a new cursor", async () => {
    const t = world("export");
    const batches = await collect(t, { kind: "INCREMENTAL", cursor: "2026-10-30" });
    const from = new URL(t.calls[0]!.url).searchParams.get("from_date");
    expect(from).toBe("2026-10-28");
    expect(batches.at(-1)).toMatchObject({ kind: "usage", records: [], cursor: "2026-11-02" });
  });

  it("honours the configured account and feature properties", async () => {
    const batches = await collect(world("export"), { kind: "FULL" }, { accountProperty: "nope" });
    expect(records(batches)).toEqual([]);
  });

  it("test connection reads today and names the project", async () => {
    const r = await mixpanelAdapter.testConnection(ctx(world("export")));
    expect(r).toMatchObject({ ok: true, externalAccountId: "3412345" });
  });

  it("explains a refused service account, a rate limit and an unexpected body in plain words", async () => {
    await expect(collect(world("error-429"))).rejects.toBeInstanceOf(ProviderHttpError);
    const rate = await collect(world("error-429")).catch((e) => e);
    expect(mixpanelAdapter.describeError(rate).plain).toContain("slow down");
    const bad = await collect(world("error-shape")).catch((e) => e);
    expect(bad).toBeInstanceOf(ProviderShapeError);
    expect(mixpanelAdapter.describeError(bad).plain).toContain("nothing from that page was saved");
    const refused = new ProviderHttpError(401);
    expect(mixpanelAdapter.describeError(refused)).toMatchObject({
      plain: "Mixpanel rejected the saved credentials.",
      action: expect.stringContaining("service account"),
    });
  });

  it("the rejected demo account is refused by the recorded world", async () => {
    const t = createFixtureTransport(loadFixture("mixpanel", "auth-rejected"));
    await expect(
      mixpanelAdapter.auth.kind === "apiKey" &&
        mixpanelAdapter.auth.validate(
          { username: "rejected-sa.demo", apiKey: "mp_rejected_secret_for_demo" },
          t,
        ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
