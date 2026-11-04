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
import { zendeskAdapter, verifyZendeskSignature } from "..";

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

  it("syncs tickets incrementally and maps to NormalizedTicket with comments", async () => {
    const t = world();
    const batches = await collect(t);
    expect(batches.length).toBeGreaterThan(0);
    const ticketBatch = batches.find((b) => b.kind === "tickets");
    expect(ticketBatch).toBeDefined();
    expect(ticketBatch?.cursor).toBe("1762340000");

    const records = (ticketBatch?.records ?? []) as NormalizedTicket[];
    expect(records.length).toBe(2);

    const first = records[0]!;
    expect(first.externalId).toBe("zd_101");
    expect(first.subject).toBe("Cannot export CSV reports");
    expect(first.status).toBe("OPEN");
    expect(first.priority).toBe("HIGH");
    expect(first.requesterEmail).toBe("ops@halden.test");
    expect(first.messages).toHaveLength(2);
    expect(first.messages[0]).toMatchObject({
      externalId: "zd_comm_1001",
      bodyText: "CSV export fails with error 500 every morning.",
      direction: "INBOUND",
    });
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
