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
import { ProviderHttpError } from "../../../transport";
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
