import { createHash, randomBytes } from "node:crypto";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { realClock, type Clock } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { openCredentials, sealCredentials } from "../credentials";

/**
 * The Usage API's per-integration ingest key (M6 B1). Only the SHA-256 and the last four
 * characters are stored; the key itself is returned once, to the Admin who asked, and is in no
 * log, audit line or response after that. Rotating replaces the hash in one statement, so the
 * old key stops working at once. 32 random bytes make a salted or slow hash unnecessary: the
 * key cannot be guessed, only looked up (Rule 9).
 */
export const INGEST_KEY_PREFIX = "nxu_";

export const hashIngestKey = (key: string) => createHash("sha256").update(key).digest("hex");

export const newIngestKey = () => `${INGEST_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;

export interface IssuedKey {
  integrationId: string;
  /** Shown once; never stored. */
  key: string;
  last4: string;
  rotated: boolean;
}

/** "Generate key" and "Rotate key" are one operation: a new key replaces any earlier one. */
export async function issueUsageApiKey(actor: Actor, clock: Clock = realClock): Promise<IssuedKey> {
  requirePermission(actor, "integrations:manage");
  const key = newIngestKey();
  const last4 = key.slice(-4);
  const data = {
    ingestKeyHash: hashIngestKey(key),
    ingestKeyLast4: last4,
    ingestKeyRotatedAt: clock(),
    status: "CONNECTED" as const,
    disconnectedAt: null,
    lastErrorPlain: null,
  };
  const db = scopedDb(actor);
  return db.$tenantTransaction(async (tx) => {
    const existing = await tx.integration.findUnique({
      where: { workspaceId_provider: { workspaceId: actor.workspaceId, provider: "USAGE_API" } },
    });
    const rotated = Boolean(existing?.ingestKeyHash);
    const row = existing
      ? await tx.integration.update({ where: { id: existing.id }, data })
      : await tx.integration.create({
          data: {
            workspaceId: actor.workspaceId,
            provider: "USAGE_API",
            connectedByMembershipId: actor.membershipId,
            connectedAt: clock(),
            ...data,
          },
        });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: rotated ? "usage_api.key_rotated" : "usage_api.key_created",
        targetType: "Integration",
        targetId: row.id,
        summary: rotated
          ? `Rotated the Usage API key (the new one ends ${last4}); the previous key stopped working`
          : `Created a Usage API key (ends ${last4})`,
      },
      tx,
    );
    return { integrationId: row.id, key, last4, rotated };
  });
}

/** The Segment shared secret (Segment signs each request with it). Sealed; never returned. */
export async function saveSegmentSecret(actor: Actor, secret: string): Promise<void> {
  requirePermission(actor, "integrations:manage");
  const value = secret.trim();
  if (value.length < 8 || value.length > 500)
    throw new Error("The shared secret needs at least 8 characters.");
  const db = scopedDb(actor);
  await db.$tenantTransaction(async (tx) => {
    const existing = await tx.integration.findUnique({
      where: { workspaceId_provider: { workspaceId: actor.workspaceId, provider: "USAGE_API" } },
    });
    const sealed = sealCredentials({
      ...(existing ? openCredentials(existing.credentialsEnc) : {}),
      webhookSecret: value,
    });
    const row = existing
      ? await tx.integration.update({
          where: { id: existing.id },
          data: { credentialsEnc: sealed, status: "CONNECTED", disconnectedAt: null },
        })
      : await tx.integration.create({
          data: {
            workspaceId: actor.workspaceId,
            provider: "USAGE_API",
            credentialsEnc: sealed,
            connectedByMembershipId: actor.membershipId,
          },
        });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "usage_api.segment_secret_saved",
        targetType: "Integration",
        targetId: row.id,
        summary: "Saved the Segment shared secret for the Usage API",
      },
      tx,
    );
  });
}
