import { describe, expect, it } from "vitest";
import type { AdapterContext } from "../../../adapter";
import {
  createFixtureTransport,
  type FixtureInteraction,
  type FixtureTransport,
} from "../../../fixture-transport";
import type { NormalizedBatch, NormalizedMail } from "../../../normalized";
import { ProviderShapeError } from "../../../transport";
import { googleEmailAdapter } from "..";

/**
 * CONNECTOR-LIVE.md, Gmail blocker 4: a FULL run follows nextPageToken until the list is
 * exhausted; an INCREMENTAL run reads only what changed since the saved historyId (history.list,
 * also paged) and saves the new one. A history id Gmail no longer keeps (404) falls back to a full
 * read. No cursor is ever made up from the clock.
 */
const NOW = new Date("2026-11-13T12:00:00Z");
const LIST = "/gmail/v1/users/me/messages";
const HISTORY = "/gmail/v1/users/me/history";

const ok = (body: unknown) => ({ status: 200, headers: {}, body });
const get = (path: string, query?: Record<string, string>) => ({
  method: "GET" as const,
  path,
  ...(query ? { query } : {}),
});
const profile = (historyId?: string): FixtureInteraction => ({
  request: get("/gmail/v1/users/me/profile"),
  response: ok({ emailAddress: "csm@company.test", ...(historyId ? { historyId } : {}) }),
});
const detail = (id: string): FixtureInteraction => ({
  request: get(`${LIST}/${id}`),
  response: ok({
    id,
    threadId: `t_${id}`,
    labelIds: ["INBOX"],
    internalDate: String(Date.UTC(2026, 10, 10)),
    payload: {
      headers: [
        { name: "From", value: "Pat <pat@customer.test>" },
        { name: "To", value: "csm@company.test" },
        { name: "Subject", value: `About ${id}` },
        { name: "Date", value: "Tue, 10 Nov 2026 09:00:00 +0000" },
      ],
      body: { data: Buffer.from(`Body of ${id}`).toString("base64url") },
    },
  }),
});
const stub = (id: string) => ({ id, threadId: `t_${id}` });

function ctx(t: FixtureTransport): AdapterContext<Record<string, unknown>> {
  return {
    workspaceId: "ws",
    integrationId: "int",
    credentials: { accessToken: "gmail-token" },
    config: {},
    transport: t,
    clock: () => NOW,
  };
}

async function run(t: FixtureTransport, opts: { kind: "FULL" | "INCREMENTAL"; cursor?: string }) {
  const batches: NormalizedBatch[] = [];
  for await (const b of googleEmailAdapter.sync(ctx(t), opts)) batches.push(b);
  const ids = batches
    .filter((b) => b.kind === "mail")
    .flatMap((b) => b.records as NormalizedMail[])
    .map((r) => r.externalId);
  const cursors = batches.map((b) => b.cursor).filter((c) => c !== undefined);
  return { ids, cursors };
}

const calls = (t: FixtureTransport, path: string) =>
  t.calls.filter((c) => new URL(c.url).pathname === path).map((c) => new URL(c.url).searchParams);

describe("Gmail paging and cursor", () => {
  it("FULL follows nextPageToken to the end and saves the profile historyId", async () => {
    const t = createFixtureTransport([
      profile("500"),
      { request: get(LIST, { pageToken: "p3" }), response: ok({ messages: [stub("m3")] }) },
      {
        request: get(LIST, { pageToken: "p2" }),
        response: ok({ messages: [stub("m2")], nextPageToken: "p3" }),
      },
      { request: get(LIST), response: ok({ messages: [stub("m1")], nextPageToken: "p2" }) },
      detail("m1"),
      detail("m2"),
      detail("m3"),
    ]);
    const { ids, cursors } = await run(t, { kind: "FULL" });
    expect(t.unmatched).toEqual([]);
    expect(ids).toEqual(["m1", "m2", "m3"]);
    expect(calls(t, LIST).map((q) => q.get("pageToken"))).toEqual([null, "p2", "p3"]);
    expect(calls(t, LIST).every((q) => q.get("maxResults") === "100")).toBe(true);
    expect(cursors).toEqual(["500"]);
  });

  it("INCREMENTAL reads history since the saved cursor, paged, and saves the newest historyId", async () => {
    const t = createFixtureTransport([
      profile("999"),
      {
        request: get(HISTORY, { startHistoryId: "500", pageToken: "h2" }),
        response: ok({
          history: [{ id: "690", messagesAdded: [{ message: stub("m5") }] }],
          historyId: "700",
        }),
      },
      {
        request: get(HISTORY, { startHistoryId: "500" }),
        response: ok({
          history: [
            { id: "610", messagesAdded: [{ message: stub("m4") }] },
            { id: "620", messagesAdded: [{ message: stub("m4") }] },
          ],
          nextPageToken: "h2",
          historyId: "650",
        }),
      },
      detail("m4"),
      detail("m5"),
    ]);
    const { ids, cursors } = await run(t, { kind: "INCREMENTAL", cursor: "500" });
    expect(t.unmatched).toEqual([]);
    expect(ids).toEqual(["m4", "m5"]);
    expect(calls(t, LIST)).toEqual([]);
    expect(calls(t, HISTORY).map((q) => q.get("historyTypes"))).toEqual([
      "messageAdded",
      "messageAdded",
    ]);
    expect(cursors).toEqual(["700"]);
  });

  it("an expired history id (404) falls back to a full read", async () => {
    const t = createFixtureTransport([
      profile("800"),
      { request: get(HISTORY), response: { status: 404, headers: {}, body: {} } },
      { request: get(LIST), response: ok({ messages: [stub("m1")] }) },
      detail("m1"),
    ]);
    const { ids, cursors } = await run(t, { kind: "INCREMENTAL", cursor: "1" });
    expect(ids).toEqual(["m1"]);
    expect(cursors).toEqual(["800"]);
  });

  it("an empty history keeps the newest historyId and fetches nothing", async () => {
    const t = createFixtureTransport([
      profile("900"),
      { request: get(HISTORY), response: ok({ historyId: "901" }) },
    ]);
    const { ids, cursors } = await run(t, { kind: "INCREMENTAL", cursor: "900" });
    expect(ids).toEqual([]);
    expect(cursors).toEqual(["901"]);
  });

  it("never makes a cursor up from the clock", async () => {
    const t = createFixtureTransport([profile(), { request: get(LIST), response: ok({}) }]);
    const { cursors } = await run(t, { kind: "FULL" });
    expect(cursors).toEqual([]);
  });

  it("refuses a page token that repeats instead of looping", async () => {
    const t = createFixtureTransport([
      profile("1"),
      { request: get(LIST), response: ok({ messages: [], nextPageToken: "same" }) },
    ]);
    await expect(run(t, { kind: "FULL" })).rejects.toBeInstanceOf(ProviderShapeError);
  });
});
