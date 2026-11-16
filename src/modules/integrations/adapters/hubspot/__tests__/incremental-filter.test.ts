import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import { createFixtureTransport, loadFixture } from "../../../fixture-transport";
import { hubspotAdapter } from "..";

/**
 * B2 regression (docs/CONNECTOR-LIVE.md, HubSpot): the incremental read searches each object by
 * its "modified since" property. For CONTACTS that property is `lastmodifieddate`: a search on
 * `hs_lastmodifieddate` is accepted by HubSpot (HTTP 200) but matches no contacts, so a contact
 * created or changed after the first full sync was never read again. Companies and deals use
 * `hs_lastmodifieddate`. Verified live against HubSpot on 2026-11-16 (see the write-up).
 */
const NOW = new Date("2026-11-16T12:00:00Z");
const SINCE = "1794829952674";

async function searchFilters() {
  const t = createFixtureTransport(
    ["auth", "owners", "companies", "contacts", "deals"].flatMap((f) => loadFixture("hubspot", f)),
  );
  const ctx: AdapterContext<{ dealsAsContracts: boolean; closedWonStage: string }> = {
    workspaceId: "ws",
    integrationId: "int",
    credentials: { accessToken: "fixture-access-token-not-a-secret" },
    config: { dealsAsContracts: true, closedWonStage: "closedwon" },
    transport: t,
    clock: () => NOW,
  };
  for await (const _ of hubspotAdapter.sync(ctx, { kind: "INCREMENTAL", cursor: SINCE })) void _;
  expect(t.unmatched).toEqual([]);
  const byObject: Record<string, unknown> = {};
  for (const c of t.calls.filter((c) => c.url.endsWith("/search"))) {
    const object = new URL(c.url).pathname.split("/").at(-2)!;
    byObject[object] = JSON.parse(c.body!).filterGroups[0].filters;
  }
  return byObject;
}

describe("HubSpot incremental search filters", () => {
  it("searches contacts by lastmodifieddate", async () => {
    expect((await searchFilters()).contacts).toEqual([
      { propertyName: "lastmodifieddate", operator: "GTE", value: SINCE },
    ]);
  });

  it("keeps hs_lastmodifieddate for companies and deals", async () => {
    const f = await searchFilters();
    for (const object of ["companies", "deals"])
      expect(f[object], object).toEqual([
        { propertyName: "hs_lastmodifieddate", operator: "GTE", value: SINCE },
      ]);
  });
});
