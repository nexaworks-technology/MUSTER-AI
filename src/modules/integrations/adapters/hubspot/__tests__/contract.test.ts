import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import {
  createFixtureTransport,
  loadFixture,
  type FixtureTransport,
} from "../../../fixture-transport";
import type { NormalizedBatch } from "../../../normalized";
import type { ProviderHttpError } from "../../../transport";
import type { z } from "zod";
import { hubspotAdapter, type hubspotConfig } from "..";

/** HubSpot contract: recorded payloads → normalized records, paging, archived, errors, OAuth. */
const NOW = new Date("2026-11-02T15:00:00Z");
const ALL = ["auth", "owners", "companies", "contacts", "deals", "writeback"];

const world = () => createFixtureTransport(ALL.flatMap((f) => loadFixture("hubspot", f)));

function ctx(
  t: FixtureTransport,
  config: Partial<z.infer<typeof hubspotConfig>> = {},
): AdapterContext<z.infer<typeof hubspotConfig>> {
  return {
    workspaceId: "ws",
    integrationId: "int",
    credentials: { accessToken: "fixture-access-token-not-a-secret" },
    config: { dealsAsContracts: false, closedWonStage: "closedwon", ...config },
    transport: t,
    clock: () => NOW,
  };
}

async function collect(
  t: FixtureTransport,
  kind: "FULL" | "INCREMENTAL" = "FULL",
  cursor?: string,
  config = {},
) {
  const out: NormalizedBatch[] = [];
  for await (const b of hubspotAdapter.sync(ctx(t, config), { kind, cursor })) out.push(b);
  return out;
}

const of = (batches: NormalizedBatch[], kind: NormalizedBatch["kind"]) =>
  batches.filter((b) => b.kind === kind).flatMap((b) => b.records) as Array<
    Record<string, unknown>
  >;

describe("HubSpot contract", () => {
  it("reads owners (both pages, archived dropped) before companies and contacts", async () => {
    const t = world();
    const batches = await collect(t);
    expect(t.unmatched).toEqual([]);
    expect(batches.map((b) => b.kind)).toEqual([
      "owners",
      "owners",
      "accounts",
      "accounts",
      "accounts",
      "contacts",
      "accounts",
    ]);
    expect(of(batches, "owners")).toEqual([
      { externalId: "101", email: "aisha@larkspur.test", name: "Aisha Bello" },
      { externalId: "102", email: "leo@larkspur.test", name: "Leo Marsh" },
      { externalId: "103", email: "former.rep@larkspur.test", name: "Former Rep" },
    ]);
    expect(
      t.calls.every((c) => c.headers?.authorization === "Bearer fixture-access-token-not-a-secret"),
    ).toBe(true);
  });

  it("maps companies across pages, keeps archived ones flagged, and leaves bad ones for ingest to reject", async () => {
    const companies = of(await collect(world()), "accounts");
    expect(companies).toEqual([
      expect.objectContaining({
        externalId: "c-1001",
        name: "Brightwell Logistics Inc.",
        domain: "brightwell-logistics.test",
        ownerExternalId: "102",
        industry: "Logistics And Supply Chain",
        employeeBand: "201-1000",
        archived: false,
      }),
      expect.objectContaining({ externalId: "c-1002", employeeBand: "1-50" }),
      expect.objectContaining({
        externalId: "c-1003",
        ownerExternalId: "103",
        employeeBand: "51-200",
      }),
      expect.objectContaining({ externalId: "c-1004", name: "" }),
      expect.objectContaining({ externalId: "c-0999", archived: true }),
    ]);
  });

  it("maps contacts with their company id from associatedcompanyid", async () => {
    const contacts = of(await collect(world()), "contacts");
    expect(contacts[0]).toEqual({
      externalId: "p-1",
      accountExternalId: "c-1002",
      name: "Jo Harper",
      email: "jo.harper@sundial-fitness.test",
      title: "Owner",
      archived: false,
    });
    expect(contacts[2]).toMatchObject({ externalId: "p-3", accountExternalId: undefined });
  });

  it("closed-won deals become contracts only when turned on, valued in minor units in the portal currency", async () => {
    expect(of(await collect(world()), "contracts")).toEqual([]);
    const contracts = of(
      await collect(world(), "FULL", undefined, { dealsAsContracts: true }),
      "contracts",
    );
    expect(contracts).toEqual([
      {
        externalId: "d-1",
        accountExternalId: "c-1003",
        startDate: "2026-06-01T00:00:00Z",
        valueMinor: 2_400_000,
        currency: "USD",
      },
    ]);
  });

  it("INCREMENTAL searches by hs_lastmodifieddate from the cursor and skips the archived list", async () => {
    const t = world();
    const batches = await collect(t, "INCREMENTAL", "1761955200000");
    const search = t.calls.find((c) => c.url.endsWith("/companies/search"));
    expect(JSON.parse(search!.body!).filterGroups[0].filters[0]).toEqual({
      propertyName: "hs_lastmodifieddate",
      operator: "GTE",
      value: "1761955200000",
    });
    expect(t.calls.some((c) => c.url.includes("archived=true"))).toBe(false);
    expect(of(batches, "accounts")).toEqual([
      expect.objectContaining({ externalId: "c-1003", ownerExternalId: "101" }),
    ]);
    expect(batches.at(-1)?.cursor).toBe(String(NOW.getTime()));
  });

  it.each([
    [
      "error-401",
      401,
      "HubSpot rejected the saved credentials.",
      "Reconnect HubSpot from Settings › Integrations.",
    ],
    [
      "error-403",
      403,
      "HubSpot refused access: the connection is missing a permission it needs.",
      undefined,
    ],
    [
      "error-429",
      429,
      "HubSpot asked us to slow down (rate limit); it will accept requests again in about 10 seconds.",
      undefined,
    ],
    ["error-500", 500, "HubSpot had a problem on its side (HTTP 500).", undefined],
  ])("%s → plain words", async (fixture, status, plain, action) => {
    const err = await collect(createFixtureTransport(loadFixture("hubspot", fixture))).catch(
      (e: unknown) => e,
    );
    expect((err as ProviderHttpError).status).toBe(status);
    const d = hubspotAdapter.describeError(err);
    expect(d.plain).toBe(plain);
    if (action) expect(d.action).toBe(action);
  });

  it("OAuth: consent URL carries state and read scopes; exchange and refresh return expiring tokens", async () => {
    const auth = hubspotAdapter.auth;
    if (auth.kind !== "oauth2") throw new Error("HubSpot signs in");
    const url = new URL(auth.authorizeUrl({ redirectUri: "https://app.test/cb", state: "st.sig" }));
    expect(url.searchParams.get("state")).toBe("st.sig");
    expect(url.searchParams.get("scope")).toContain("crm.objects.companies.read");
    const t = world();
    const creds = await auth.exchange("code-1", "https://app.test/cb", t);
    expect(creds).toMatchObject({
      accessToken: "fixture-access-token-not-a-secret",
      refreshToken: "fixture-refresh-token-not-a-secret",
    });
    expect(new Date(creds.expiresAt!).getTime()).toBeGreaterThan(Date.now());
    const refreshed = await auth.refresh(creds, t);
    expect(refreshed).toMatchObject({
      accessToken: "fixture-access-token-refreshed",
      refreshToken: "fixture-refresh-token-not-a-secret",
    });
    expect(t.calls[0]?.body).toContain("code=code-1");
  });

  it("testConnection names the portal", async () => {
    expect(await hubspotAdapter.testConnection(ctx(world()))).toEqual({
      ok: true,
      message: "Connected to HubSpot portal 4242001. Read-only.",
      externalAccountId: "4242001",
    });
  });

  it("write-back declares only the account owner and PATCHes hubspot_owner_id", async () => {
    expect(hubspotAdapter.writeBack!.fields).toEqual([
      { key: "ownerMembershipId", label: "Account owner" },
    ]);
    const t = world();
    await hubspotAdapter.writeBack!.push(ctx(t), {
      field: "ownerMembershipId",
      accountId: "a1",
      externalId: "c-1001",
      value: "101",
    });
    expect(JSON.parse(t.calls[0]!.body!)).toEqual({ properties: { hubspot_owner_id: "101" } });
    await expect(
      hubspotAdapter.writeBack!.push(ctx(t), {
        field: "name",
        accountId: "a1",
        externalId: "c-1001",
        value: "x",
      }),
    ).rejects.toThrow(/only the account owner/);
  });
});
