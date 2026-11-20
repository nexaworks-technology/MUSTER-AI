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
import type { NormalizedBatch, NormalizedTicket } from "../../../normalized";
import { OAuthClientRefusedError } from "../../../errors";
import { ProviderHttpError, type HttpRequest, type HttpResponse } from "../../../transport";
import type { FixtureInteraction } from "../../../fixture-transport";
import { MAX_COMMENT_PAGES, MAX_EXPORT_PAGES, zendeskAdapter, verifyZendeskSignature } from "..";

/**
 * Zendesk contract: recorded payloads labelled "authored from docs, not captured".
 * Tests ticket sync, webhook signature verification + dedupe, and plain-words errors.
 */
const NOW = new Date("2026-11-05T12:00:00Z");
const SECRET = "zendesk_webhook_signing_secret_32_bytes";

function ctx(t: FixtureTransport): AdapterContext<{ subdomain?: string }> {
  return {
    workspaceId: "ws_zendesk",
    integrationId: "int_zendesk",
    credentials: {
      apiKey: "fixture-zendesk-api-token",
      username: "admin@larkspur.test",
      site: "larkspur",
    },
    config: { subdomain: "larkspur" },
    transport: t,
    clock: () => NOW,
  };
}

const world = () => createFixtureTransport(loadFixture("zendesk", "tickets"));

async function collect(t: FixtureTransport) {
  const out: NormalizedBatch[] = [];
  for await (const b of zendeskAdapter.sync(ctx(t), { kind: "FULL" })) out.push(b);
  return out;
}

/** Inline interactions in the documented live shapes, for the scenarios the main fixture lacks. */
type ZdUser = { id: number; name: string; email: string };
const ticket = (id: number, requesterId: number) => ({
  id,
  created_at: "2026-11-04T09:00:00Z",
  updated_at: "2026-11-04T09:00:00Z",
  subject: `Ticket ${id}`,
  description: "Opening text",
  priority: "normal",
  status: "open",
  requester_id: requesterId,
});
const comment = (id: number, authorId: number, text: string, at: string) => ({
  id,
  type: "Comment",
  author_id: authorId,
  body: text,
  plain_body: text,
  public: true,
  created_at: at,
});
function exportPage(o: {
  start?: string;
  endTime?: number;
  endOfStream?: boolean;
  users: ZdUser[];
  tickets: Array<ReturnType<typeof ticket>>;
}): FixtureInteraction {
  return {
    request: {
      method: "GET",
      path: "/api/v2/incremental/tickets.json",
      query: { start_time: o.start ?? "0", include: "users" },
    },
    response: {
      status: 200,
      headers: {},
      body: {
        tickets: o.tickets,
        users: o.users,
        count: o.tickets.length,
        end_of_stream: o.endOfStream ?? true,
        end_time: o.endTime ?? 1762340000,
      },
    },
  };
}
const showMany = (ids: string, users: ZdUser[]): FixtureInteraction => ({
  request: { method: "GET", path: "/api/v2/users/show_many.json", query: { ids } },
  response: { status: 200, headers: {}, body: { users } },
});
const commentsOf = (
  id: number,
  comments: Array<ReturnType<typeof comment>>,
): FixtureInteraction => ({
  request: {
    method: "GET",
    path: `/api/v2/tickets/${id}/comments.json`,
    query: { "page[size]": "100" },
  },
  response: {
    status: 200,
    headers: {},
    body: { comments, users: [], meta: { has_more: false, after_cursor: null } },
  },
});

const webhookBody = (name: string) =>
  readFileSync(path.join(import.meta.dirname, "..", "__fixtures__", `${name}.json`), "utf8");

describe("Zendesk contract", () => {
  it("authenticates with Basic auth email/token:key and validates connection", async () => {
    const t = world();
    const res = await zendeskAdapter.testConnection(ctx(t));
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Connected to Zendesk");

    const call = t.calls.find((c) => c.url.includes("/api/v2/users/me.json"));
    expect(call).toBeDefined();
    // Basic auth header base64(admin@larkspur.test/token:fixture-zendesk-api-token)
    const expectedAuth = `Basic ${Buffer.from("admin@larkspur.test/token:fixture-zendesk-api-token").toString("base64")}`;
    expect(call?.headers?.authorization).toBe(expectedAuth);
  });

  it("asks the export for the users sideload and maps the documented live shapes", async () => {
    const t = world();
    const batches = await collect(t);
    const ticketBatch = batches.find((b) => b.kind === "tickets");
    expect(ticketBatch).toBeDefined();
    expect(ticketBatch?.cursor).toBe("1762340000");

    const exportCall = t.calls.find((c) => c.url.includes("/api/v2/incremental/tickets.json"));
    const u = new URL(exportCall!.url);
    expect(u.searchParams.get("start_time")).toBe("0");
    expect(u.searchParams.get("include")).toBe("users");

    // 103 is deleted: dropped, never mapped to OPEN, and its comments are never read.
    const records = (ticketBatch?.records ?? []) as NormalizedTicket[];
    expect(records.map((r) => r.externalId)).toEqual(["101", "102"]);
    expect(t.calls.some((c) => c.url.includes("/tickets/103/"))).toBe(false);

    const first = records[0]!;
    expect(first.subject).toBe("Cannot export CSV reports");
    expect(first.status).toBe("OPEN");
    expect(first.priority).toBe("HIGH");
    // The export carries only requester_id; the email comes from the sideloaded users.
    expect(first.requesterEmail).toBe("ops@halden.test");
    expect(first.requesterName).toBe("Halden Ops");

    const second = records[1]!;
    expect(second.requesterEmail).toBe("unknown@stranger.test");
    expect(second.priority).toBe("NORMAL"); // priority null
    expect(second.status).toBe("OPEN"); // new
  });

  it("makes the description the first message, skips private comments, keeps replies in order", async () => {
    const t = world();
    const [batch] = await collect(t);
    const first = (batch!.records as NormalizedTicket[])[0]!;
    expect(first.messages.map((m) => m.externalId)).toEqual(["101_desc", "9003"]);
    expect(first.messages[0]).toMatchObject({
      direction: "INBOUND",
      bodyText: "CSV export fails with error 500 every morning.",
      fromAddress: "ops@halden.test",
    });
    expect(first.messages[1]).toMatchObject({
      direction: "OUTBOUND",
      bodyText: "We are looking into this server-side error.",
      fromAddress: "admin@larkspur.test",
    });
    // The internal note never becomes a message.
    expect(JSON.stringify(first)).not.toContain("do not tell the customer");
    // Comments are read per ticket from the documented endpoint, cursor-paged.
    const call = t.calls.find((c) => c.url.includes("/api/v2/tickets/101/comments.json"));
    expect(new URL(call!.url).searchParams.get("page[size]")).toBe("100");
  });

  it("falls back to users/show_many when a requester is not in the sideload", async () => {
    const t = createFixtureTransport([
      exportPage({ users: [], tickets: [ticket(201, 2001)] }),
      showMany("2001", [{ id: 2001, name: "Fallback Person", email: "fallback@acme.test" }]),
      commentsOf(201, [comment(8001, 2001, "Opening text", "2026-11-04T09:00:00Z")]),
    ]);
    const [batch] = await collect(t);
    const rec = (batch!.records as NormalizedTicket[])[0]!;
    expect(rec.requesterEmail).toBe("fallback@acme.test");
    const call = t.calls.find((c) => c.url.includes("/api/v2/users/show_many.json"));
    expect(new URL(call!.url).searchParams.get("ids")).toBe("2001");
    expect(t.unmatched).toEqual([]);
  });

  it("never guesses a requester email: unresolved stays empty with an honest reason", async () => {
    const t = createFixtureTransport([
      exportPage({ users: [], tickets: [ticket(202, 2002)] }),
      showMany("2002", []),
      commentsOf(202, [comment(8002, 2002, "Opening text", "2026-11-04T09:00:00Z")]),
    ]);
    const [batch] = await collect(t);
    const rec = (batch!.records as NormalizedTicket[])[0]!;
    expect(rec.requesterEmail).toBeUndefined();
    expect(rec.requesterUnresolvedReason).toMatch(/Zendesk returned no email for requester 2002/);
  });

  it("treats end_time null with no tickets as a valid empty export and keeps the cursor", async () => {
    const t = createFixtureTransport([
      {
        request: {
          method: "GET",
          path: "/api/v2/incremental/tickets.json",
          query: { start_time: "1762340000", include: "users" },
        },
        response: {
          status: 200,
          headers: {},
          body: { tickets: [], users: [], count: 0, end_of_stream: true, end_time: null },
        },
      },
    ]);
    const out: NormalizedBatch[] = [];
    for await (const b of zendeskAdapter.sync(ctx(t), {
      kind: "INCREMENTAL",
      cursor: "1762340000",
    }))
      out.push(b);
    expect(out).toHaveLength(1);
    expect(out[0]?.records).toHaveLength(0);
    // Explicit: no new end_time means the saved cursor does not move.
    expect(out[0]?.cursor).toBe("1762340000");
  });

  it("loops the export until end_of_stream and saves the final end_time", async () => {
    const t = createFixtureTransport([
      exportPage({ start: "5", endTime: 100, endOfStream: false, users: [], tickets: [] }),
      exportPage({ start: "100", endTime: 200, endOfStream: true, users: [], tickets: [] }),
    ]);
    const out: NormalizedBatch[] = [];
    for await (const b of zendeskAdapter.sync(ctx(t), { kind: "INCREMENTAL", cursor: "5" }))
      out.push(b);
    expect(out.map((b) => b.cursor)).toEqual(["100", "200"]);
    expect(t.calls.filter((c) => c.url.includes("/incremental/tickets.json"))).toHaveLength(2);
  });

  it("stops at the export page cap and keeps the cursor it reached", async () => {
    let n = 0;
    const calls: string[] = [];
    const transport = {
      mode: "fixture" as const,
      async request(req: { url: string }) {
        calls.push(req.url);
        n += 1;
        return {
          status: 200,
          headers: {},
          body: { tickets: [], users: [], count: 0, end_of_stream: false, end_time: 1000 + n },
        };
      },
    };
    const out: NormalizedBatch[] = [];
    for await (const b of zendeskAdapter.sync(
      { ...ctx(world()), transport },
      { kind: "INCREMENTAL", cursor: "1000" },
    ))
      out.push(b);
    expect(out).toHaveLength(MAX_EXPORT_PAGES);
    expect(out.at(-1)?.cursor).toBe(String(1000 + MAX_EXPORT_PAGES));
  });

  it("follows comment pagination until exhausted, in time order, and caps it", async () => {
    const t = createFixtureTransport([
      exportPage({
        users: [{ id: 3001, name: "P", email: "p@acme.test" }],
        tickets: [ticket(301, 3001)],
      }),
      {
        request: {
          method: "GET",
          path: "/api/v2/tickets/301/comments.json",
          query: { "page[size]": "100", "page[after]": "CURSOR2" },
        },
        response: {
          status: 200,
          headers: {},
          body: {
            comments: [comment(7003, 3001, "Third", "2026-11-04T11:00:00Z")],
            users: [],
            meta: { has_more: false, after_cursor: null },
          },
        },
      },
      {
        request: {
          method: "GET",
          path: "/api/v2/tickets/301/comments.json",
          query: { "page[size]": "100" },
        },
        response: {
          status: 200,
          headers: {},
          body: {
            comments: [
              comment(7001, 3001, "Opening text", "2026-11-04T09:00:00Z"),
              comment(7002, 3001, "Second", "2026-11-04T10:00:00Z"),
            ],
            users: [],
            meta: { has_more: true, after_cursor: "CURSOR2" },
          },
        },
      },
    ]);
    const [batch] = await collect(t);
    const rec = (batch!.records as NormalizedTicket[])[0]!;
    expect(rec.messages.map((m) => m.bodyText)).toEqual(["Opening text", "Second", "Third"]);
    expect(MAX_COMMENT_PAGES).toBeGreaterThan(1);
  });

  it("does not map a deleted status to OPEN even when it is the only ticket", async () => {
    const t = createFixtureTransport([
      exportPage({ users: [], tickets: [{ ...ticket(401, 4001), status: "deleted" }] }),
    ]);
    const [batch] = await collect(t);
    expect(batch!.records).toHaveLength(0);
  });

  it("verifies webhook HMAC-SHA256 signature with timestamp within tolerance", () => {
    const body = webhookBody("webhook-ticket-created");
    const timestamp = String(Math.floor(NOW.getTime() / 1000));
    const validSignature = createHmac("sha256", SECRET)
      .update(timestamp + body)
      .digest("base64");

    const validReq = {
      headers: {
        "x-zendesk-webhook-signature": validSignature,
        "x-zendesk-webhook-signature-timestamp": timestamp,
      },
      rawBody: body,
      url: "https://app.test/api/integrations/zendesk/webhook/int_1",
    };

    expect(verifyZendeskSignature(validReq, SECRET, NOW)).toBe(true);

    // Bad signature fails
    const badReq = {
      ...validReq,
      headers: {
        ...validReq.headers,
        "x-zendesk-webhook-signature": "invalid_sig",
      },
    };
    expect(verifyZendeskSignature(badReq, SECRET, NOW)).toBe(false);

    // Stale timestamp (> 300s) fails
    const staleReq = {
      ...validReq,
      headers: {
        ...validReq.headers,
        "x-zendesk-webhook-signature-timestamp": String(Math.floor(NOW.getTime() / 1000) - 301),
      },
    };
    expect(verifyZendeskSignature(staleReq, SECRET, NOW)).toBe(false);
  });

  it("translates webhook payload to NormalizedEvent with ticket batch", () => {
    const raw = JSON.parse(webhookBody("webhook-ticket-created"));
    const events = zendeskAdapter.webhook!.toEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0]?.externalEventId).toBe("zd_evt_201");
    expect(events[0]?.type).toBe("ticket.created");
    expect(events[0]?.batches[0]?.kind).toBe("tickets");
    const ticket = (events[0]?.batches[0]?.records as NormalizedTicket[])[0];
    expect(ticket?.externalId).toBe("zd_102");
    expect(ticket?.subject).toBe("API rate limits exceeded");
  });

  it("describes provider errors in plain words without echoing tokens", () => {
    const err401 = new ProviderHttpError(401);
    const desc401 = zendeskAdapter.describeError(err401);
    expect(desc401.plain).toContain("Zendesk rejected the saved credentials");
    expect(desc401.action).toContain("Zendesk subdomain");

    const err429 = new ProviderHttpError(429, 60);
    const desc429 = zendeskAdapter.describeError(err429);
    expect(desc429.plain).toContain("rate limit");
  });
});

/**
 * OAuth (client_credentials). Zendesk removed API-token creation (CONNECTOR-LIVE.md, B7): the primary
 * connection is now an OAuth client. Shapes are authored from Zendesk's OAuth migration guide and the
 * Create Token for Grant Type reference, not captured.
 */
function oauthCtx(
  transport: AdapterContext<{ subdomain?: string }>["transport"],
  extra: Record<string, string> = {},
): AdapterContext<{ subdomain?: string }> {
  return {
    workspaceId: "ws_zendesk",
    integrationId: "int_zendesk",
    credentials: {
      clientId: "zd-client-id-fixture",
      clientSecret: "zd-client-secret-fixture",
      site: "larkspur",
      ...extra,
    },
    config: { subdomain: "larkspur" },
    transport,
    clock: () => NOW,
  };
}
const oauthWorld = () =>
  createFixtureTransport([
    ...loadFixture("zendesk", "oauth-token"),
    ...loadFixture("zendesk", "tickets"),
  ]);
const isTokenFetch = (r: HttpRequest) => r.method === "POST" && r.url.endsWith("/oauth/tokens");
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, body });

/** A transport driven by a function; records every request. */
function scripted(handler: (req: HttpRequest, calls: HttpRequest[]) => HttpResponse) {
  const calls: HttpRequest[] = [];
  return {
    mode: "fixture" as const,
    calls,
    async request(req: HttpRequest) {
      calls.push(req);
      return handler(req, calls);
    },
  };
}

describe("Zendesk OAuth client_credentials", () => {
  it("fetches a token the documented way: form-encoded POST to the subdomain's /oauth/tokens, scope read", async () => {
    const t = oauthWorld();
    for await (const _ of zendeskAdapter.sync(oauthCtx(t), { kind: "FULL" })) void _;
    const fetches = t.calls.filter(isTokenFetch);
    expect(fetches).toHaveLength(1); // once per run, not once per request
    const f = fetches[0]!;
    expect(f.url).toBe("https://larkspur.zendesk.com/oauth/tokens");
    expect(f.headers?.["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(f.headers?.authorization).toBeUndefined();
    const body = new URLSearchParams(f.body);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "client_credentials",
      client_id: "zd-client-id-fixture",
      client_secret: "zd-client-secret-fixture",
      scope: "read",
    });
  });

  it("sends Authorization: Bearer on the export, show_many and comments calls", async () => {
    const t = createFixtureTransport([
      ...loadFixture("zendesk", "oauth-token"),
      exportPage({ users: [], tickets: [ticket(501, 5001)] }),
      showMany("5001", [{ id: 5001, name: "Via ShowMany", email: "sm@acme.test" }]),
      commentsOf(501, [comment(6001, 5001, "Opening text", "2026-11-04T09:00:00Z")]),
    ]);
    for await (const _ of zendeskAdapter.sync(oauthCtx(t), { kind: "FULL" })) void _;
    const api = t.calls.filter((c) => !isTokenFetch(c));
    expect(api.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v2/incremental/tickets.json",
      "/api/v2/users/show_many.json",
      "/api/v2/tickets/501/comments.json",
    ]);
    for (const c of api)
      expect(c.headers?.authorization).toBe("Bearer fixture-oauth-access-token-aaaa");
    expect(t.unmatched).toEqual([]);
  });

  it("Test connection reads users/me.json with the Bearer token", async () => {
    const t = oauthWorld();
    const res = await zendeskAdapter.testConnection(oauthCtx(t));
    expect(res.ok).toBe(true);
    const me = t.calls.find((c) => c.url.endsWith("/api/v2/users/me.json"));
    expect(me?.headers?.authorization).toBe("Bearer fixture-oauth-access-token-aaaa");
  });

  it("validates OAuth client fields at connect time through the same token fetch", async () => {
    const t = oauthWorld();
    if (zendeskAdapter.auth.kind !== "apiKey") throw new Error("Zendesk auth is not apiKey");
    await zendeskAdapter.auth.validate(oauthCtx(t).credentials, t, { subdomain: "larkspur" });
    expect(t.calls.filter(isTokenFetch)).toHaveLength(1);
    expect(t.calls.some((c) => c.url.endsWith("/api/v2/users/me.json"))).toBe(true);
  });

  it("on a 401 from the API refetches the token exactly once and retries exactly once", async () => {
    let tokens = 0;
    const t = scripted((req) => {
      if (isTokenFetch(req)) {
        tokens += 1;
        return json(201, { access_token: `tok-${tokens}`, token_type: "bearer", scope: "read" });
      }
      if (req.headers?.authorization === "Bearer tok-1")
        return json(401, { error: "invalid_token" });
      return json(200, { tickets: [], users: [], count: 0, end_of_stream: true, end_time: null });
    });
    const out: NormalizedBatch[] = [];
    for await (const b of zendeskAdapter.sync(oauthCtx(t), { kind: "FULL" })) out.push(b);
    expect(out).toHaveLength(1);
    expect(t.calls.filter(isTokenFetch)).toHaveLength(2);
    const exports = t.calls.filter((c) => c.url.includes("/incremental/tickets.json"));
    expect(exports.map((c) => c.headers?.authorization)).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  it("fails honestly when the retry is also a 401: no third attempt", async () => {
    let tokens = 0;
    const t = scripted((req) => {
      if (isTokenFetch(req)) {
        tokens += 1;
        return json(201, { access_token: `tok-${tokens}`, token_type: "bearer", scope: "read" });
      }
      return json(401, { error: "invalid_token" });
    });
    const it_ = zendeskAdapter.sync(oauthCtx(t), { kind: "FULL" })[Symbol.asyncIterator]();
    await expect(it_.next()).rejects.toMatchObject({ name: "ProviderHttpError", status: 401 });
    expect(t.calls.filter(isTokenFetch)).toHaveLength(2);
    expect(t.calls.filter((c) => !isTokenFetch(c))).toHaveLength(2);
  });

  it("a refused token request (client revoked or secret wrong) names the likely cause and reads nothing", async () => {
    const t = scripted((req) =>
      isTokenFetch(req) ? json(400, { error: "invalid_client" }) : json(200, {}),
    );
    const res = await zendeskAdapter.testConnection(oauthCtx(t));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/OAuth client/i);
    expect(res.message).toMatch(/revoked|deleted/i);
    expect(res.message).toMatch(/secret/i);
    expect(res.message).not.toContain("zd-client-secret-fixture");

    const batches: NormalizedBatch[] = [];
    const run = async () => {
      for await (const b of zendeskAdapter.sync(oauthCtx(t), { kind: "FULL" })) batches.push(b);
    };
    await expect(run()).rejects.toBeInstanceOf(OAuthClientRefusedError);
    expect(batches).toEqual([]); // nothing yielded, so nothing saved and the cursor stays
    expect(t.calls.every(isTokenFetch)).toBe(true); // no API call was made without a token

    const d = zendeskAdapter.describeError(new OAuthClientRefusedError(400));
    expect(d.plain).toMatch(/revoked|deleted/i);
    expect(d.plain).toMatch(/secret/i);
    expect(d.action).toMatch(/client ID and secret/i);
  });

  it("a token endpoint outage is not blamed on the credentials", async () => {
    const t = scripted((req) => (isTokenFetch(req) ? json(503, {}) : json(200, {})));
    const res = await zendeskAdapter.testConnection(oauthCtx(t));
    expect(res.ok).toBe(false);
    expect(res.message).not.toMatch(/revoked/i);
  });

  it("prefers OAuth when client fields are present and the legacy token path still works without them", async () => {
    const both = oauthWorld();
    await zendeskAdapter.testConnection(
      oauthCtx(both, { apiKey: "legacy-token", username: "admin@larkspur.test" }),
    );
    expect(both.calls.some(isTokenFetch)).toBe(true);
    expect(both.calls.at(-1)?.headers?.authorization).toMatch(/^Bearer /);

    const legacy = world();
    await zendeskAdapter.testConnection(ctx(legacy));
    expect(legacy.calls.some(isTokenFetch)).toBe(false);
    expect(legacy.calls[0]?.headers?.authorization).toMatch(/^Basic /);
  });

  it("refuses a half-filled OAuth client before any request", async () => {
    const t = oauthWorld();
    const c = oauthCtx(t);
    c.credentials = { clientId: "only-an-id", site: "larkspur" };
    await expect(zendeskAdapter.testConnection(c)).rejects.toThrow(/client secret/i);
    expect(t.calls).toHaveLength(0);
  });
});
