import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { ADAPTERS } from "../adapters";
import { sealCredentials } from "../credentials";
import { createFixtureTransport, loadFixture } from "../fixture-transport";
import { ingestBatch } from "../ingest.service";
import type { NormalizedBatch } from "../normalized";
import { processWebhookEvent, receiveWebhook } from "../webhooks.service";

/**
 * Integration tests for Zendesk and Freshdesk connectors:
 * - Webhook signature verification and deduplication through WebhookEvent.
 * - Ingest of tickets and comments through ExternalRef.
 * - Unmatched ticket routes to UnmatchedInbound.
 * - Sync-twice proof (second sync changes nothing).
 */
const NOW = new Date("2026-11-05T12:00:00Z");

describe("Support connectors integration (Zendesk & Freshdesk)", () => {
  it("Zendesk: verifies webhook, dedupes by externalEventId, ingests to Ticket + Conversation + Message", async () => {
    const { actor: admin } = await createTestAdmin("zendesk-webhook");
    const db = scopedDb(admin);
    const secret = "zd_secret_integration_test_32_bytes";

    // Create an account with contact matching the webhook requester
    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Acme Corp",
        domain: "acme.test",
        tier: "HIGH_TOUCH",
      },
    });
    const contact = await db.contact.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        name: "Alice Acme",
        email: "alice@acme.test",
      },
    });

    const integration = await db.integration.create({
      data: {
        workspaceId: admin.workspaceId,
        provider: "ZENDESK",
        status: "CONNECTED",
        credentialsEnc: sealCredentials({
          apiKey: "tok_zd_test",
          username: "admin@acme.test",
          site: "acme",
          webhookSecret: secret,
        }),
      },
    });

    const rawPayload = JSON.stringify({
      id: "zd_webhook_evt_001",
      event_type: "ticket.created",
      ticket: {
        id: "zd_ticket_999",
        subject: "Login failing for all users",
        status: "open",
        priority: "high",
        requester: { email: "alice@acme.test", name: "Alice Acme" },
        created_at: "2026-11-05T11:00:00Z",
        comments: [
          {
            id: "zd_comm_9991",
            body: "None of our team can log in via SAML today.",
            author_email: "alice@acme.test",
            created_at: "2026-11-05T11:00:00Z",
          },
        ],
      },
    });

    const timestamp = String(Math.floor(NOW.getTime() / 1000));
    const sig = createHmac("sha256", secret).update(timestamp + rawPayload).digest("base64");

    const req = {
      headers: {
        "x-zendesk-webhook-signature": sig,
        "x-zendesk-webhook-signature-timestamp": timestamp,
      },
      rawBody: rawPayload,
      url: `https://app.test/api/integrations/zendesk/webhook/${integration.id}`,
    };

    // 1. Receive webhook
    const res1 = await receiveWebhook("ZENDESK", integration.id, req, {
      clock: () => NOW,
      enqueue: async () => {},
    });
    expect(res1.status).toBe(202);

    const eventRow = await db.webhookEvent.findFirstOrThrow({
      where: { integrationId: integration.id, externalEventId: "zd_webhook_evt_001" },
    });
    expect(eventRow.status).toBe("RECEIVED");

    // 2. Replay with identical event ID is deduped
    const res2 = await receiveWebhook("ZENDESK", integration.id, req, {
      clock: () => NOW,
      enqueue: async () => {},
    });
    expect(res2.status).toBe(200);
    const eventCount = await db.webhookEvent.count({
      where: { integrationId: integration.id, externalEventId: "zd_webhook_evt_001" },
    });
    expect(eventCount).toBe(1);

    // 3. Process the webhook event
    const procRes = await processWebhookEvent({
      workspaceId: admin.workspaceId,
      webhookEventId: eventRow.id,
    });
    expect(procRes.status).toBe("PROCESSED");

    // 4. Verify Ticket, Conversation, Message, and InboxItem were created
    const ticketRow = await db.ticket.findFirst({
      where: { workspaceId: admin.workspaceId, externalId: "zd_ticket_999" },
    });
    expect(ticketRow).toBeDefined();
    expect(ticketRow?.accountId).toBe(account.id);
    expect(ticketRow?.contactId).toBe(contact.id);
    expect(ticketRow?.subject).toBe("Login failing for all users");

    const messageRow = await db.message.findFirst({
      where: { workspaceId: admin.workspaceId, conversationId: ticketRow!.conversationId! },
    });
    expect(messageRow).toBeDefined();
    expect(messageRow?.bodyText).toContain("None of our team can log in");

    const inboxItem = await db.inboxItem.findFirst({
      where: { workspaceId: admin.workspaceId, sourceId: ticketRow!.id },
    });
    expect(inboxItem).toBeDefined();
    expect(inboxItem?.accountId).toBe(account.id);
  });

  it("Zendesk sync: unmatched ticket routes to UnmatchedInbound; sync-twice proof", async () => {
    const { actor: admin } = await createTestAdmin("zendesk-sync");
    const db = scopedDb(admin);

    // Create account matching first ticket in fixture (ops@halden.test -> Halden Retail)
    const halden = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Halden Retail",
        domain: "halden.test",
        tier: "HIGH_TOUCH",
      },
    });
    await db.contact.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: halden.id,
        name: "Halden Ops",
        email: "ops@halden.test",
      },
    });
    // Note: The second ticket in fixture is from unknown@stranger.test which matches NO account

    const transport = createFixtureTransport(loadFixture("zendesk", "tickets"));
    const integration = await db.integration.create({
      data: {
        workspaceId: admin.workspaceId,
        provider: "ZENDESK",
        status: "CONNECTED",
        credentialsEnc: sealCredentials({
          apiKey: "fixture-zendesk-api-token",
          username: "admin@larkspur.test",
          site: "larkspur",
        }),
      },
    });

    const target = {
      workspaceId: admin.workspaceId,
      integrationId: integration.id,
      source: "ZENDESK" as const,
    };

    // First sync: collects batches from adapter and ingests
    const batches: NormalizedBatch[] = [];
    const adapter = ADAPTERS.ZENDESK!;
    for await (const b of adapter.sync(
      {
        workspaceId: admin.workspaceId,
        integrationId: integration.id,
        credentials: { apiKey: "fixture-zendesk-api-token", username: "admin@larkspur.test", site: "larkspur" },
        config: {},
        transport,
        clock: () => NOW,
      },
      { kind: "FULL" },
    )) {
      batches.push(b);
    }

    const firstRunResults = [];
    for (const b of batches) {
      firstRunResults.push(await ingestBatch(target, b));
    }

    // 1 matched ticket on Halden
    const haldenTicket = await db.ticket.findFirst({
      where: { workspaceId: admin.workspaceId, externalId: "zd_101" },
    });
    expect(haldenTicket).toBeDefined();
    expect(haldenTicket?.accountId).toBe(halden.id);

    // 1 unmatched ticket in UnmatchedInbound
    const unmatched = await db.unmatchedInbound.findFirst({
      where: { workspaceId: admin.workspaceId, externalId: "zd_102" },
    });
    expect(unmatched).toBeDefined();
    expect(unmatched?.provider).toBe("ZENDESK");
    expect(unmatched?.fromAddress).toBe("unknown@stranger.test");

    // SYNC-TWICE PROOF: running the identical batches a second time changes nothing
    const secondRunResults = [];
    for (const b of batches) {
      secondRunResults.push(await ingestBatch(target, b));
    }

    expect(secondRunResults[0]?.counts.created).toBe(0);
    expect(secondRunResults[0]?.counts.updated).toBe(0);
    // All known records counted as unchanged
    expect(secondRunResults[0]?.counts.unchanged).toBeGreaterThan(0);

    const totalTicketsAfter = await db.ticket.count({ where: { workspaceId: admin.workspaceId } });
    expect(totalTicketsAfter).toBe(1); // exactly 1, no duplicate
  });

  it("Freshdesk: verifies shared secret, dedupes webhook, and ingests tickets", async () => {
    const { actor: admin } = await createTestAdmin("freshdesk-webhook");
    const db = scopedDb(admin);
    const secret = "freshdesk_custom_header_secret_value";

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Brightwell Logistics",
        domain: "brightwell.test",
        tier: "HIGH_TOUCH",
      },
    });
    const contact = await db.contact.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        name: "Maya Ortiz",
        email: "maya@brightwell.test",
      },
    });

    const integration = await db.integration.create({
      data: {
        workspaceId: admin.workspaceId,
        provider: "FRESHDESK",
        status: "CONNECTED",
        credentialsEnc: sealCredentials({
          apiKey: "tok_fd_test",
          site: "brightwell",
          webhookSecret: secret,
        }),
      },
    });

    const rawPayload = JSON.stringify({
      freshdesk_webhook: {
        ticket_id: "fd_ticket_888",
        ticket_subject: "Cannot connect warehouse API",
        ticket_status: "Open",
        ticket_priority: "High",
        requester_email: "maya@brightwell.test",
        requester_name: "Maya Ortiz",
        created_at: "2026-11-05T10:00:00Z",
        conversation: {
          id: "fd_conv_8881",
          body_text: "The warehouse endpoint is giving 502 Bad Gateway.",
          incoming: true,
          created_at: "2026-11-05T10:00:00Z",
        },
      },
    });

    const req = {
      headers: {
        "x-freshdesk-webhook-secret": secret,
      },
      rawBody: rawPayload,
      url: `https://app.test/api/integrations/freshdesk/webhook/${integration.id}`,
    };

    // 1. Unverified request (missing or wrong secret) is refused with 401
    const badRes = await receiveWebhook("FRESHDESK", integration.id, {
      ...req,
      headers: { "x-freshdesk-webhook-secret": "wrong" },
    });
    expect(badRes.status).toBe(401);

    // 2. Verified request accepted and deduped
    const res1 = await receiveWebhook("FRESHDESK", integration.id, req, {
      clock: () => NOW,
      enqueue: async () => {},
    });
    expect(res1.status).toBe(202);

    const eventRow = await db.webhookEvent.findFirstOrThrow({
      where: { integrationId: integration.id, externalEventId: "fd_ticket_888" },
    });
    expect(eventRow.status).toBe("RECEIVED");

    // Replay deduped
    const res2 = await receiveWebhook("FRESHDESK", integration.id, req, {
      clock: () => NOW,
      enqueue: async () => {},
    });
    expect(res2.status).toBe(200);
    expect(await db.webhookEvent.count({ where: { integrationId: integration.id } })).toBe(1);

    // 3. Process webhook
    await processWebhookEvent({
      workspaceId: admin.workspaceId,
      webhookEventId: eventRow.id,
    });

    const ticket = await db.ticket.findFirst({
      where: { workspaceId: admin.workspaceId, externalId: "fd_ticket_888" },
    });
    expect(ticket).toBeDefined();
    expect(ticket?.accountId).toBe(account.id);
    expect(ticket?.contactId).toBe(contact.id);
  });
});
