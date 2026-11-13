import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import {
  createFixtureTransport,
  type FixtureInteraction,
  type FixtureTransport,
} from "../../../fixture-transport";
import type { NormalizedBatch, NormalizedMail } from "../../../normalized";
import { ProviderShapeError } from "../../../transport";
import { microsoftEmailAdapter } from "..";

/**
 * CONNECTOR-LIVE.md, Microsoft blocker 3: a delta run follows @odata.nextLink page by page until
 * the last page's @odata.deltaLink, and saves that delta token. A nextLink pointing anywhere but
 * Microsoft Graph is refused (the bearer token would go with it). No cursor is made up.
 */
const NOW = new Date("2026-11-13T12:00:00Z");
const DELTA = "/v1.0/me/mailFolders/inbox/messages/delta";
const GRAPH = "https://graph.microsoft.com";

const ok = (body: unknown) => ({ status: 200, headers: {}, body });
const me: FixtureInteraction = {
  request: { method: "GET", path: "/v1.0/me" },
  response: ok({ id: "u1", mail: "csm@company.test", userPrincipalName: "csm@company.test" }),
};
const msg = (id: string) => ({
  id,
  conversationId: `c_${id}`,
  sentDateTime: "2026-11-10T09:00:00Z",
  subject: `About ${id}`,
  bodyPreview: `Body of ${id}`,
  isDraft: false,
  from: { emailAddress: { address: "pat@customer.test", name: "Pat" } },
  toRecipients: [{ emailAddress: { address: "csm@company.test" } }],
});
const page = (query: Record<string, string> | undefined, body: unknown): FixtureInteraction => ({
  request: { method: "GET", path: DELTA, ...(query ? { query } : {}) },
  response: ok(body),
});

function ctx(t: FixtureTransport): AdapterContext<Record<string, unknown>> {
  return {
    workspaceId: "ws",
    integrationId: "int",
    credentials: { accessToken: "graph-token" },
    config: {},
    transport: t,
    clock: () => NOW,
  };
}

async function run(t: FixtureTransport, opts: { kind: "FULL" | "INCREMENTAL"; cursor?: string }) {
  const batches: NormalizedBatch[] = [];
  for await (const b of microsoftEmailAdapter.sync(ctx(t), opts)) batches.push(b);
  return {
    ids: batches.flatMap((b) => b.records as NormalizedMail[]).map((r) => r.externalId),
    cursors: batches.map((b) => b.cursor).filter((c) => c !== undefined),
  };
}

const deltaCalls = (t: FixtureTransport) =>
  t.calls.filter((c) => new URL(c.url).pathname === DELTA).map((c) => new URL(c.url));

describe("Outlook delta paging and cursor", () => {
  it("follows nextLink to the last page and saves its delta token", async () => {
    const t = createFixtureTransport([
      me,
      page(
        { $skiptoken: "s3" },
        {
          value: [msg("c")],
          "@odata.deltaLink": `${GRAPH}${DELTA}?$deltatoken=d-final`,
        },
      ),
      page(
        { $skiptoken: "s2" },
        {
          value: [msg("b")],
          "@odata.nextLink": `${GRAPH}${DELTA}?$skiptoken=s3`,
        },
      ),
      page(undefined, { value: [msg("a")], "@odata.nextLink": `${GRAPH}${DELTA}?$skiptoken=s2` }),
    ]);
    const { ids, cursors } = await run(t, { kind: "FULL" });
    expect(t.unmatched).toEqual([]);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(deltaCalls(t).map((u) => u.searchParams.get("$skiptoken"))).toEqual([null, "s2", "s3"]);
    expect(cursors).toEqual(["d-final"]);
  });

  it("INCREMENTAL starts from the saved delta token and follows its pages too", async () => {
    const t = createFixtureTransport([
      me,
      page(
        { $skiptoken: "s2" },
        {
          value: [msg("y")],
          "@odata.deltaLink": `${GRAPH}${DELTA}?$deltatoken=d-next`,
        },
      ),
      page(
        { $deltatoken: "d-old" },
        {
          value: [msg("x")],
          "@odata.nextLink": `${GRAPH}${DELTA}?$skiptoken=s2`,
        },
      ),
    ]);
    const { ids, cursors } = await run(t, { kind: "INCREMENTAL", cursor: "d-old" });
    expect(t.unmatched).toEqual([]);
    expect(ids).toEqual(["x", "y"]);
    expect(cursors).toEqual(["d-next"]);
  });

  it("refuses a nextLink outside Microsoft Graph without calling it", async () => {
    const t = createFixtureTransport([
      me,
      page(undefined, {
        value: [msg("a")],
        "@odata.nextLink": "https://evil.example.test/v1.0/me/mailFolders/inbox/messages/delta",
      }),
    ]);
    await expect(run(t, { kind: "FULL" })).rejects.toBeInstanceOf(ProviderShapeError);
    expect(t.calls.some((c) => new URL(c.url).host !== "graph.microsoft.com")).toBe(false);
  });

  it("saves no cursor when Graph sends no deltaLink (never a clock value)", async () => {
    const t = createFixtureTransport([me, page(undefined, { value: [msg("a")] })]);
    const { ids, cursors } = await run(t, { kind: "FULL" });
    expect(ids).toEqual(["a"]);
    expect(cursors).toEqual([]);
  });

  it("refuses a nextLink that repeats instead of looping", async () => {
    const t = createFixtureTransport([
      me,
      page(
        { $skiptoken: "s2" },
        {
          value: [],
          "@odata.nextLink": `${GRAPH}${DELTA}?$skiptoken=s2`,
        },
      ),
      page(undefined, { value: [], "@odata.nextLink": `${GRAPH}${DELTA}?$skiptoken=s2` }),
    ]);
    await expect(run(t, { kind: "FULL" })).rejects.toBeInstanceOf(ProviderShapeError);
  });
});
