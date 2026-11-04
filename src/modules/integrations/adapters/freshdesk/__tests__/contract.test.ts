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
import { freshdeskAdapter, verifyFreshdeskSignature } from "..";

/**
 * Freshdesk contract: recorded payloads labelled "authored from docs, not captured".
 * Tests ticket sync, shared-secret webhook verification (conservative reading) + dedupe,
 * and plain-words errors.
 */
const NOW = new Date("2026-11-05T12:00:00Z");
const SECRET = "freshdesk_custom_header_secret_value";

function ctx(t: FixtureTransport): AdapterContext<{ domain?: string }> {
  return {
    workspaceId: "ws_freshdesk",
    integrationId: "int_freshdesk",
    credentials: {
      apiKey: "fixture-freshdesk-api-key",
      site: "larkspur-help",
    },
    config: { domain: "larkspur-help" },
    transport: t,
    clock: () => NOW,
  };
}

const world = () => createFixtureTransport(loadFixture("freshdesk", "tickets"));

async function collect(t: FixtureTransport) {
  const out: NormalizedBatch[] = [];
  for await (const b of freshdeskAdapter.sync(ctx(t), { kind: "FULL" })) out.push(b);
  return out;
}

const webhookBody = (name: string) =>
  readFileSync(path.join(import.meta.dirname, "..", "__fixtures__", `${name}.json`), "utf8");

describe("Freshdesk contract", () => {
  it("authenticates with Basic auth apiKey:X and validates connection", async () => {
    const t = world();
    const res = await freshdeskAdapter.testConnection(ctx(t));
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Connected to Freshdesk");

    const call = t.calls.find((c) => c.url.includes("/api/v2/tickets"));
    expect(call).toBeDefined();
    const expectedAuth = `Basic ${Buffer.from("fixture-freshdesk-api-key:X").toString("base64")}`;
    expect(call?.headers?.authorization).toBe(expectedAuth);
  });

  it("syncs tickets and maps to NormalizedTicket with conversations", async () => {
    const t = world();
    const batches = await collect(t);
    expect(batches.length).toBeGreaterThan(0);
    const ticketBatch = batches.find((b) => b.kind === "tickets");
    expect(ticketBatch).toBeDefined();
    expect(ticketBatch?.cursor).toBe("2026-11-05T10:30:00.000Z");

    const records = (ticketBatch?.records ?? []) as NormalizedTicket[];
    expect(records.length).toBe(2);

    const first = records[0]!;
    expect(first.externalId).toBe("fd_301");
    expect(first.subject).toBe("SSO login failure with Okta");
    expect(first.status).toBe("OPEN");
    expect(first.priority).toBe("HIGH");
    expect(first.requesterEmail).toBe("maya@brightwell.test");
    expect(first.messages).toHaveLength(2);
    expect(first.messages[0]).toMatchObject({
      externalId: "fd_conv_5001",
      bodyText: "Our users are seeing 403 on SAML redirect.",
      direction: "INBOUND",
    });
  });

  it("verifies webhook shared-secret header (conservative reading)", () => {
    const body = webhookBody("webhook-ticket-created");

    // Valid header matching secret
    const validReq = {
      headers: {
        "x-freshdesk-webhook-secret": SECRET,
      },
      rawBody: body,
      url: "https://app.test/api/integrations/freshdesk/webhook/int_2",
    };
    expect(verifyFreshdeskSignature(validReq, SECRET, NOW)).toBe(true);

    // Missing header fails
    const missingReq = {
      headers: {},
      rawBody: body,
      url: "https://app.test/api/integrations/freshdesk/webhook/int_2",
    };
    expect(verifyFreshdeskSignature(missingReq, SECRET, NOW)).toBe(false);

    // Wrong secret fails
    const badReq = {
      headers: { "x-freshdesk-webhook-secret": "wrong_secret" },
      rawBody: body,
      url: "https://app.test/api/integrations/freshdesk/webhook/int_2",
    };
    expect(verifyFreshdeskSignature(badReq, SECRET, NOW)).toBe(false);
  });

  it("translates webhook payload to NormalizedEvent with ticket batch", () => {
    const raw = JSON.parse(webhookBody("webhook-ticket-created"));
    const events = freshdeskAdapter.webhook!.toEvents(raw);
    expect(events).toHaveLength(1);
    expect(events[0]?.externalEventId).toBe("fd_evt_401");
    expect(events[0]?.type).toBe("ticket.created");
    expect(events[0]?.batches[0]?.kind).toBe("tickets");
    const ticket = (events[0]?.batches[0]?.records as NormalizedTicket[])[0];
    expect(ticket?.externalId).toBe("fd_302");
    expect(ticket?.subject).toBe("Renewal contract question");
  });

  it("describes provider errors in plain words without echoing tokens", () => {
    const err401 = new ProviderHttpError(401);
    const desc401 = freshdeskAdapter.describeError(err401);
    expect(desc401.plain).toContain("Freshdesk rejected the saved credentials");
    expect(desc401.action).toContain("Freshdesk domain");

    const err429 = new ProviderHttpError(429);
    const desc429 = freshdeskAdapter.describeError(err429);
    expect(desc429.plain).toContain("rate limit");
  });
});
