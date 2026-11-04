import { createHmac, timingSafeEqual } from "node:crypto";
import { writeAudit } from "@/lib/audit";
import { scopedDb } from "@/lib/db/scoped";

const UNSECURE_FALLBACK_SECRET = "$REMOVED_UNSUBSCRIBE_FALLBACK";

function getSecret(): string {
  return (
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.SESSION_SECRET ||
    UNSECURE_FALLBACK_SECRET
  );
}

export interface UnsubscribePayload {
  workspaceId: string;
  contactId: string;
  email: string;
  exp?: number;
}

/**
 * Creates an HMAC-signed unsubscribe token for a recipient (spec §6J2).
 */
export function createUnsubscribeToken(
  payload: { workspaceId: string; contactId: string; email: string },
  expiresInSeconds = 30 * 86_400, // 30 days
): string {
  const secret = getSecret();
  const data: UnsubscribePayload = {
    workspaceId: payload.workspaceId,
    contactId: payload.contactId,
    email: payload.email.toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  };

  const payloadStr = Buffer.from(JSON.stringify(data)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadStr).digest("base64url");
  return `${payloadStr}.${signature}`;
}

/**
 * Verifies an HMAC-signed unsubscribe token. Returns null if invalid or expired.
 */
export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  try {
    const [payloadStr, signature] = token.split(".");
    if (!payloadStr || !signature) return null;

    const secret = getSecret();
    const expectedSig = createHmac("sha256", secret).update(payloadStr).digest("base64url");

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    const data = JSON.parse(Buffer.from(payloadStr, "base64url").toString("utf8")) as UnsubscribePayload;
    if (data.exp && Date.now() / 1000 > data.exp) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Processes an unsubscribe request: marks email suppressed and records audit.
 */
export async function processUnsubscribe(
  token: string,
): Promise<{ success: boolean; email?: string; error?: string }> {
  const verified = verifyUnsubscribeToken(token);
  if (!verified) {
    return { success: false, error: "Invalid or expired unsubscribe link." };
  }

  const { workspaceId, contactId, email } = verified;
  const db = scopedDb({ workspaceId });
  const now = new Date();

  await db.$tenantTransaction(async (tx) => {
    // 1. Create or update suppression entry
    await tx.emailSuppression.upsert({
      where: {
        workspaceId_email: {
          workspaceId,
          email: email.toLowerCase(),
        },
      },
      create: {
        workspaceId,
        email: email.toLowerCase(),
        reason: "UNSUBSCRIBED",
      },
      update: {
        reason: "UNSUBSCRIBED",
      },
    });

    // 2. Update any pending campaign recipients for this contact
    await tx.campaignRecipient.updateMany({
      where: {
        workspaceId,
        contactId,
        status: { in: ["QUEUED", "HELD"] },
      },
      data: {
        status: "HELD",
        heldReason: "The address is on the suppression list (unsubscribed).",
        unsubscribedAt: now,
      },
    });

    // 3. Audit trail
    await writeAudit(
      {
        workspaceId,
        actorType: "PORTAL_CONTACT",
        action: "outbound.suppressed",
        targetType: "Contact",
        targetId: contactId,
        summary: `Contact unsubscribed (${email})`,
        after: { email, reason: "UNSUBSCRIBED" },
      },
      tx,
    );
  });

  return { success: true, email };
}
