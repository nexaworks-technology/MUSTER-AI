import { createHmac, timingSafeEqual } from "node:crypto";
import { writeAudit } from "@/lib/audit";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";

export interface WebhookHeaders {
  id?: string | null;
  timestamp?: string | null;
  signature?: string | null;
}

/**
 * Verifies a Resend (Svix-standard) webhook signature per provider documentation.
 * Format: svix-id, svix-timestamp, svix-signature (v1,<base64>).
 */
export function verifyWebhookSignature(
  headers: WebhookHeaders,
  rawBody: string,
  secretOverride?: string,
): boolean {
  const secret = secretOverride || process.env.RESEND_WEBHOOK_SECRET || process.env.EMAIL_WEBHOOK_SECRET;
  if (!secret) return false;

  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  // 1. Verify timestamp is within 5 minutes tolerance to prevent replay attacks
  const timestampNum = Number.parseInt(timestamp, 10);
  if (Number.isNaN(timestampNum)) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestampNum) > 300) {
    return false;
  }

  // 2. Prepare secret key (strip 'whsec_' prefix if present)
  const cleanSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let secretBuffer: Buffer;
  try {
    secretBuffer = Buffer.from(cleanSecret, "base64");
  } catch {
    secretBuffer = Buffer.from(cleanSecret, "utf8");
  }

  // 3. Compute expected signature over id.timestamp.body
  const toSign = `${id}.${timestamp}.${rawBody}`;
  const hmac = createHmac("sha256", secretBuffer);
  hmac.update(toSign);
  const expectedSigBase64 = hmac.digest("base64");

  // 4. Compare with signatures in the header (header can contain space-separated 'v1,sig1 v1,sig2')
  const signatures = signature.split(" ");
  for (const part of signatures) {
    const [version, sig] = part.split(",");
    if (version === "v1" && sig) {
      const sigBuf = Buffer.from(sig);
      const expectedBuf = Buffer.from(expectedSigBase64);
      if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
        return true;
      }
    }
  }

  return false;
}

export interface EmailWebhookEvent {
  type: string;
  created_at?: string;
  data: {
    email_id?: string;
    id?: string;
    to?: string[] | string;
    recipient?: string;
    bounce_type?: string;
    workspace_id?: string;
    tags?: Record<string, string> | Array<{ name: string; value: string }>;
    [key: string]: unknown;
  };
}

export interface ProcessWebhookOptions {
  workspaceId?: string;
}

/**
 * Handles verified email webhook events from the provider.
 */
export async function processEmailWebhook(
  event: EmailWebhookEvent,
  options?: ProcessWebhookOptions,
): Promise<{ processed: boolean; detail?: string }> {
  const providerMessageId = event.data.email_id || event.data.id;
  if (!providerMessageId) {
    return { processed: false, detail: "No email ID in payload" };
  }

  // Extract workspaceId from options, payload, or tags if available
  let explicitWorkspaceId =
    options?.workspaceId ||
    (typeof event.data.workspace_id === "string" ? event.data.workspace_id : undefined);

  if (!explicitWorkspaceId && event.data.tags) {
    if (Array.isArray(event.data.tags)) {
      const tag = event.data.tags.find((t) => t.name === "workspace_id");
      if (tag) explicitWorkspaceId = tag.value;
    } else if (typeof event.data.tags === "object") {
      explicitWorkspaceId = (event.data.tags as Record<string, string>).workspace_id;
    }
  }

  let workspaceId = explicitWorkspaceId;
  let msg = null;

  if (workspaceId) {
    msg = await scopedDb({ workspaceId }).outboundMessage.findFirst({
      where: { providerMessageId },
    });
  } else {
    // Resolve workspace through tenant-scoped lookups
    const workspaces = await rawDb.workspace.findMany({ select: { id: true } });
    for (const w of workspaces) {
      const found = await scopedDb({ workspaceId: w.id }).outboundMessage.findFirst({
        where: { providerMessageId },
      });
      if (found) {
        msg = found;
        workspaceId = w.id;
        break;
      }
    }
  }

  if (!msg || !workspaceId) {
    return { processed: false, detail: `Message ${providerMessageId} not found` };
  }

  const now = event.created_at ? new Date(event.created_at) : new Date();
  const db = scopedDb({ workspaceId });

  switch (event.type) {
    case "email.delivered": {
      await db.$tenantTransaction(async (tx) => {
        await tx.campaignRecipient.updateMany({
          where: { outboundMessageId: msg.id },
          data: { deliveredAt: now },
        });
      });
      return { processed: true, detail: "Delivered recorded" };
    }

    case "email.opened": {
      await db.$tenantTransaction(async (tx) => {
        await tx.campaignRecipient.updateMany({
          where: { outboundMessageId: msg.id },
          data: { openedAt: now },
        });
      });
      return { processed: true, detail: "Opened recorded" };
    }

    case "email.clicked": {
      await db.$tenantTransaction(async (tx) => {
        await tx.campaignRecipient.updateMany({
          where: { outboundMessageId: msg.id },
          data: { clickedAt: now },
        });
      });
      return { processed: true, detail: "Clicked recorded" };
    }

    case "email.bounced": {
      await db.$tenantTransaction(async (tx) => {
        await tx.outboundMessage.update({
          where: { id: msg.id },
          data: { status: "BOUNCED" },
        });
        await tx.campaignRecipient.updateMany({
          where: { outboundMessageId: msg.id },
          data: {
            status: "FAILED",
            bouncedAt: now,
            heldReason: "Delivery bounced by recipient mail server.",
          },
        });
        // Suppress address and mark contact BOUNCED
        await tx.emailSuppression.upsert({
          where: {
            workspaceId_email: {
              workspaceId,
              email: msg.toEmail.toLowerCase(),
            },
          },
          create: {
            workspaceId,
            email: msg.toEmail.toLowerCase(),
            reason: "BOUNCED",
          },
          update: {
            reason: "BOUNCED",
          },
        });
        await tx.contact.update({
          where: { id: msg.contactId },
          data: { status: "BOUNCED" },
        });
        await writeAudit(
          {
            workspaceId,
            actorType: "SYSTEM",
            action: "contact.bounced",
            targetType: "Contact",
            targetId: msg.contactId,
            summary: `Email bounced for ${msg.toEmail}`,
            after: { email: msg.toEmail, providerMessageId },
          },
          tx,
        );
      });
      return { processed: true, detail: "Bounced recorded" };
    }

    case "email.complained": {
      await db.$tenantTransaction(async (tx) => {
        await tx.campaignRecipient.updateMany({
          where: { outboundMessageId: msg.id },
          data: { unsubscribedAt: now },
        });
        await tx.emailSuppression.upsert({
          where: {
            workspaceId_email: {
              workspaceId,
              email: msg.toEmail.toLowerCase(),
            },
          },
          create: {
            workspaceId,
            email: msg.toEmail.toLowerCase(),
            reason: "COMPLAINED",
          },
          update: {
            reason: "COMPLAINED",
          },
        });
        await writeAudit(
          {
            workspaceId,
            actorType: "PORTAL_CONTACT",
            action: "outbound.suppressed",
            targetType: "Contact",
            targetId: msg.contactId,
            summary: `Spam complaint received for ${msg.toEmail}`,
            after: { email: msg.toEmail, reason: "COMPLAINED" },
          },
          tx,
        );
      });
      return { processed: true, detail: "Complaint recorded" };
    }

    default:
      return { processed: false, detail: `Ignored event type ${event.type}` };
  }
}
