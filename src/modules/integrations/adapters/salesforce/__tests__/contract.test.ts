import type { z } from "zod";
import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import {
  createFixtureTransport,
  loadFixture,
  type FixtureTransport,
} from "../../../fixture-transport";
import type { NormalizedBatch } from "../../../normalized";
import type { ProviderHttpError } from "../../../transport";
import { salesforceAdapter, type salesforceConfig } from "..";

/** Salesforce contract: SOQL pages via nextRecordsUrl, IsDeleted, opportunities, errors, OAuth. */
const NOW = new Date("2026-11-02T15:00:00Z");
const INSTANCE = "https://larkspur-dev.my.salesforce.test";
const world = () =>
  createFixtureTransport(
    ["auth", "users", "accounts", "contacts", "opportunities", "writeback"].flatMap((f) =>
      loadFixture("salesforce", f),
    ),
  );

function ctx(t: FixtureTransport, config: Partial<z.infer<typeof salesforceConfig>> = {}) {
  return {
    workspaceId: "ws",
    integrationId: "int",
    credentials: { accessToken: "fixture-sf-access-not-a-secret", instanceUrl: INSTANCE },
    config: { opportunitiesAsContracts: false, ...config },
    transport: t,
    clock: () => NOW,
  } satisfies AdapterContext<z.infer<typeof salesforceConfig>>;
}

async function collect(
  t: FixtureTransport,
  kind: "FULL" | "INCREMENTAL" = "FULL",
  cursor?: string,
  config = {},
) {
  const out: NormalizedBatch[] = [];
  for await (const b of salesforceAdapter.sync(ctx(t, config), { kind, cursor })) out.push(b);
  return out;
}
const of = (b: NormalizedBatch[], kind: NormalizedBatch["kind"]) =>
  b.filter((x) => x.kind === kind).flatMap((x) => x.records) as Array<Record<string, unknown>>;

describe("Salesforce contract", () => {
  it("reads users, accounts (following nextRecordsUrl), contacts with queryAll on the instance URL", async () => {
    const t = world();
    const batches = await collect(t);
    expect(t.unmatched).toEqual([]);
    expect(t.calls.every((c) => c.url.startsWith(INSTANCE))).toBe(true);
    expect(t.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/services/data/v61.0/queryAll",
      "/services/data/v61.0/queryAll",
      "/services/data/v61.0/query/01gACC-2000",
      "/services/data/v61.0/queryAll",
    ]);
    expect(of(batches, "owners")).toHaveLength(3);
    expect(of(batches, "accounts")).toEqual([
      expect.objectContaining({
        externalId: "0015f00000HALDN",
        domain: "halden-retail.test",
        employeeBand: undefined,
        industry: undefined,
      }),
      expect.objectContaining({
        externalId: "0015f00000BRITE",
        industry: "Transportation",
        employeeBand: "201-1000",
        ownerExternalId: "0055f00000SALES",
      }),
      expect.objectContaining({
        externalId: "0015f00000PINEC",
        domain: "https://www.pinecrest-health.test",
        employeeBand: "201-1000",
        archived: false,
      }),
      expect.objectContaining({ externalId: "0015f00000GONEX", archived: true }),
    ]);
    expect(of(batches, "contacts")).toEqual([
      expect.objectContaining({
        externalId: "0035f00000RINAK",
        accountExternalId: "0015f00000PINEC",
        name: "Rina Kapoor",
      }),
      expect.objectContaining({ externalId: "0035f00000LONER", accountExternalId: undefined }),
      expect.objectContaining({ externalId: "0035f00000GONEC", archived: true }),
    ]);
    expect(batches.at(-1)?.cursor).toBe("2026-11-02T15:00:00Z");
  });

  it("INCREMENTAL adds LastModifiedDate >= cursor; a cursor it did not write is ignored", async () => {
    const t = world();
    await collect(t, "INCREMENTAL", "2026-11-01T02:00:00Z");
    const accountsQ = new URL(t.calls[1]!.url).searchParams.get("q")!;
    expect(accountsQ).toContain("FROM Account WHERE LastModifiedDate >= 2026-11-01T02:00:00Z");
    const t2 = world();
    await collect(t2, "INCREMENTAL", "1 OR Name != null");
    expect(new URL(t2.calls[1]!.url).searchParams.get("q")).not.toContain("WHERE");
  });

  it("won opportunities become contracts only when turned on, in the org's currency", async () => {
    expect(of(await collect(world()), "contracts")).toEqual([]);
    expect(
      of(
        await collect(world(), "FULL", undefined, { opportunitiesAsContracts: true }),
        "contracts",
      ),
    ).toEqual([
      {
        externalId: "0065f00000PINEW",
        accountExternalId: "0015f00000PINEC",
        startDate: "2026-05-15",
        valueMinor: 3_600_000,
        currency: "USD",
      },
    ]);
  });

  it.each([
    ["error-401", 401, "Salesforce rejected the saved credentials."],
    [
      "error-403",
      403,
      "Salesforce refused access: the connection is missing a permission it needs.",
    ],
    [
      "error-429",
      429,
      "Salesforce asked us to slow down (rate limit); it will accept requests again in about 60 seconds.",
    ],
    ["error-500", 500, "Salesforce had a problem on its side (HTTP 500)."],
  ])("%s → plain words", async (fixture, status, plain) => {
    const err = await collect(createFixtureTransport(loadFixture("salesforce", fixture))).catch(
      (e: unknown) => e,
    );
    expect((err as ProviderHttpError).status).toBe(status);
    expect(salesforceAdapter.describeError(err).plain).toBe(plain);
  });

  it("an expired session answers 401 to the old token only", async () => {
    const t = createFixtureTransport(
      ["session-expired", "users"].flatMap((f) => loadFixture("salesforce", f)),
    );
    const expired = {
      ...ctx(t),
      credentials: { accessToken: "fixture-sf-expired", instanceUrl: INSTANCE },
    };
    const err = await (async () => {
      for await (const _ of salesforceAdapter.sync(expired, { kind: "FULL" })) void _;
    })().catch((e: unknown) => e);
    expect((err as ProviderHttpError).status).toBe(401);
  });

  it("OAuth exchange keeps the instance URL; refresh keeps the refresh token", async () => {
    const auth = salesforceAdapter.auth;
    if (auth.kind !== "oauth2") throw new Error("Salesforce signs in");
    const url = new URL(auth.authorizeUrl({ redirectUri: "https://app.test/cb", state: "s.t" }));
    expect(url.searchParams.get("scope")).toBe("api refresh_token");
    const t = world();
    const c = await auth.exchange("code-9", "https://app.test/cb", t);
    expect(c).toEqual({
      accessToken: "fixture-sf-access-not-a-secret",
      refreshToken: "fixture-sf-refresh-not-a-secret",
      instanceUrl: INSTANCE,
    });
    expect(await auth.refresh(c, t)).toEqual({
      accessToken: "fixture-sf-access-refreshed",
      refreshToken: "fixture-sf-refresh-not-a-secret",
      instanceUrl: INSTANCE,
    });
  });

  it("testConnection names the org; write-back PATCHes OwnerId and accepts 204", async () => {
    expect(await salesforceAdapter.testConnection(ctx(world()))).toMatchObject({
      ok: true,
      externalAccountId: "00D5f000000LARK",
    });
    expect(salesforceAdapter.writeBack!.fields).toEqual([
      { key: "ownerMembershipId", label: "Account owner" },
    ]);
    const t = world();
    await salesforceAdapter.writeBack!.push(ctx(t), {
      field: "ownerMembershipId",
      accountId: "a",
      externalId: "0015f00000HALDN",
      value: "0055f00000AISHA",
    });
    expect(JSON.parse(t.calls[0]!.body!)).toEqual({ OwnerId: "0055f00000AISHA" });
  });
});
