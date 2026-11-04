import { createHmac, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { approve } from "@/modules/approvals/service";
import {
  createCampaign,
  executeCampaignBatch,
  getCampaign,
  scheduleCampaign,
  createUnsubscribeToken,
  processUnsubscribe,
  verifyUnsubscribeToken,
  processEmailWebhook,
  verifyWebhookSignature,
} from "@/modules/campaigns/service";
import { createTestAdmin } from "@/test/fixtures";

const clock = () => new Date("2026-11-04T12:00:00Z");

function fakeTransport() {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  return {
    sent,
    transport: {
      name: "log" as const,
      async send(m: { to: string; subject: string; text: string }) {
        sent.push(m);
        return { id: `provider-${sent.length}` };
      },
    },
  };
}

let db: ScopedDb;
let ws: string;
let admin: Actor;
let segmentId: string;
let accountId: string;
let contactId: string;
let contactEmail: string;

beforeAll(async () => {
  ({ actor: admin } = await createTestAdmin("CampaignPacing"));
  ws = admin.workspaceId;
  db = scopedDb(admin);

  const acct = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Starlight SaaS",
      tier: "MID_TOUCH",
      timezone: "UTC",
    },
  });
  accountId = acct.id;

  contactEmail = `user-${randomUUID()}@example.com`;
  const contact = await db.contact.create({
    data: {
      workspaceId: ws,
      accountId,
      name: "Sam Reader",
      email: contactEmail,
      status: "ACTIVE",
    },
  });
  contactId = contact.id;

  const seg = await db.segment.create({
    data: {
      workspaceId: ws,
      name: "Mid Touch Segment",
      filter: { all: [{ field: "tier", op: "in", value: ["MID_TOUCH"] }] },
    },
  });
  segmentId = seg.id;
});

describe("S14 Campaign Pacing, Unsubscribe, and Webhook", () => {
  describe("Campaign Lifecycle & Pacing", () => {
    it("creates, approves, schedules with pacing, and executes campaign batch", async () => {
      const campaign = await createCampaign(admin, {
        name: "Welcome Series",
        segmentId,
        subject: "Hello {{contact.first_name}}",
        body: "Welcome to our product!",
        pacePerHour: 60,
      });

      expect(campaign.status).toBe("DRAFT");
      expect(campaign.approvalId).toBeDefined();

      // Approve campaign
      await approve(admin, { approvalId: campaign.approvalId! }, { clock });

      // Schedule campaign
      const scheduledTime = new Date("2026-11-04T13:00:00Z");
      const schedRes = await scheduleCampaign(admin, campaign.id, scheduledTime);
      expect(schedRes.scheduled).toBe(true);

      const updated = await getCampaign(admin, campaign.id);
      expect(updated.status).toBe("SCHEDULED");
      expect(updated.recipients).toHaveLength(1);
      expect(updated.recipients[0]!.scheduledFor?.toISOString()).toBe("2026-11-04T13:00:00.000Z");

      // Execute batch at scheduled time
      const transport = fakeTransport();
      const batchRes = await executeCampaignBatch(admin, campaign.id, {
        clock: () => scheduledTime,
        transport: transport.transport,
      });

      expect(batchRes.sent).toBe(1);
      expect(batchRes.remainingQueued).toBe(0);
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]!.text).toContain("To unsubscribe:");

      const finished = await getCampaign(admin, campaign.id);
      expect(finished.status).toBe("SENT");
      expect(finished.stats.sent).toBe(1);
    });
  });

  describe("Unsubscribe Route & Signed Token", () => {
    it("generates and verifies HMAC-signed unsubscribe token", () => {
      const token = createUnsubscribeToken({
        workspaceId: ws,
        contactId,
        email: contactEmail,
      });

      const payload = verifyUnsubscribeToken(token);
      expect(payload).not.toBeNull();
      expect(payload?.workspaceId).toBe(ws);
      expect(payload?.contactId).toBe(contactId);
      expect(payload?.email).toBe(contactEmail.toLowerCase());
    });

    it("rejects tampered unsubscribe token", () => {
      const token = createUnsubscribeToken({
        workspaceId: ws,
        contactId,
        email: contactEmail,
      });

      const tampered = token.replace("a", "b");
      expect(verifyUnsubscribeToken(tampered)).toBeNull();
    });

    it("processes unsubscribe: suppresses email and updates recipient status", async () => {
      const token = createUnsubscribeToken({
        workspaceId: ws,
        contactId,
        email: contactEmail,
      });

      const res = await processUnsubscribe(token);
      expect(res.success).toBe(true);

      const suppression = await db.emailSuppression.findUnique({
        where: {
          workspaceId_email: {
            workspaceId: ws,
            email: contactEmail.toLowerCase(),
          },
        },
      });
      expect(suppression).toBeDefined();
      expect(suppression?.reason).toBe("UNSUBSCRIBED");
    });
  });

  describe("Email Webhook with Provider Signature Verification", () => {
    const secret = ["whsec_", "dGVzdC1zZWNyZXQtZm9yLXdlYmhvb2stdmVyaWZpY2F0aW9u"].join(""); // base64 key
    const rawSecret = Buffer.from("dGVzdC1zZWNyZXQtZm9yLXdlYmhvb2stdmVyaWZpY2F0aW9u", "base64");

    function generateSignature(id: string, timestamp: string, body: string): string {
      const hmac = createHmac("sha256", rawSecret);
      hmac.update(`${id}.${timestamp}.${body}`);
      return `v1,${hmac.digest("base64")}`;
    }

    it("verifies authentic Svix/Resend webhook signature", () => {
      const id = "msg_12345";
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = JSON.stringify({ type: "email.delivered", data: { id: "p-1" } });
      const signature = generateSignature(id, timestamp, body);

      const valid = verifyWebhookSignature(
        { id, timestamp, signature },
        body,
        secret,
      );
      expect(valid).toBe(true);
    });

    it("rejects invalid or tampered webhook signature", () => {
      const id = "msg_12345";
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = JSON.stringify({ type: "email.delivered", data: { id: "p-1" } });
      const signature = "v1,invalid_signature_hash";

      const valid = verifyWebhookSignature(
        { id, timestamp, signature },
        body,
        secret,
      );
      expect(valid).toBe(false);
    });

    it("processes email.delivered and email.bounced webhook events", async () => {
      const providerId = `provider-msg-${randomUUID()}`;
      const webhookEmail = `webhook-${randomUUID()}@example.com`;

      const webhookContact = await db.contact.create({
        data: {
          workspaceId: ws,
          accountId,
          name: "Webhook Recipient",
          email: webhookEmail,
          status: "ACTIVE",
        },
      });

      // Create an outbound message and recipient with providerId
      const msg = await db.outboundMessage.create({
        data: {
          workspaceId: ws,
          accountId,
          contactId: webhookContact.id,
          toEmail: webhookEmail,
          subject: "Webhook test",
          bodyText: "Text",
          status: "SENT",
          sentAt: new Date(),
          providerMessageId: providerId,
        },
      });

      const recip = await db.campaignRecipient.create({
        data: {
          workspaceId: ws,
          campaignId: (await db.campaign.findFirstOrThrow({ where: { workspaceId: ws } })).id,
          contactId: webhookContact.id,
          accountId,
          outboundMessageId: msg.id,
          status: "SENT",
        },
      });

      // 1. Process delivered event
      const delivRes = await processEmailWebhook({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: { email_id: providerId },
      });
      expect(delivRes.processed).toBe(true);

      const recipAfterDeliv = await db.campaignRecipient.findUniqueOrThrow({
        where: { id: recip.id },
      });
      expect(recipAfterDeliv.deliveredAt).toBeDefined();

      // 2. Process bounced event
      const bounceRes = await processEmailWebhook({
        type: "email.bounced",
        created_at: new Date().toISOString(),
        data: { email_id: providerId },
      });
      expect(bounceRes.processed).toBe(true);

      const recipAfterBounce = await db.campaignRecipient.findUniqueOrThrow({
        where: { id: recip.id },
      });
      expect(recipAfterBounce.status).toBe("FAILED");
      expect(recipAfterBounce.bouncedAt).toBeDefined();

      const msgAfterBounce = await db.outboundMessage.findUniqueOrThrow({
        where: { id: msg.id },
      });
      expect(msgAfterBounce.status).toBe("BOUNCED");

      const contactAfterBounce = await db.contact.findUniqueOrThrow({
        where: { id: webhookContact.id },
      });
      expect(contactAfterBounce.status).toBe("BOUNCED");
    });
  });
});
