import type { IntegrationProvider, IntegrationStatus } from "@prisma/client";
import { rawDb } from "./raw";

/**
 * Inbound calls (webhooks, Slack interactivity) arrive with no session, so the request itself
 * names the integration. Each lookup sets one transaction-local setting that a read-only RLS
 * policy matches against exactly one Integration row (the Invitation-token pattern). Everything
 * after the lookup runs through scopedDb with the workspace the row belongs to.
 */
export interface InboundIntegration {
  id: string;
  workspaceId: string;
  provider: IntegrationProvider;
  status: IntegrationStatus;
  credentialsEnc: string | null;
}

const select = {
  id: true,
  workspaceId: true,
  provider: true,
  status: true,
  credentialsEnc: true,
} as const;

const CUID_LIKE = /^[a-z0-9]{20,40}$/;

/** The integration a webhook URL names, or null. The id is checked for shape before any query. */
export async function findIntegrationForWebhook(
  integrationId: string,
): Promise<InboundIntegration | null> {
  if (!CUID_LIKE.test(integrationId)) return null;
  const [, row] = await rawDb.$transaction([
    rawDb.$executeRaw`SELECT set_config('app.webhook_integration_id', ${integrationId}, true)`,
    rawDb.integration.findFirst({ where: { id: integrationId }, select }),
  ]);
  return row;
}

/**
 * The Slack integration connected to a Slack team, or null. A team connected to more than one
 * workspace is ambiguous, so it resolves to nothing: a Slack click must never land in a tenant
 * it cannot be proven to belong to.
 */
export async function findSlackIntegrationByTeam(
  teamId: string,
): Promise<InboundIntegration | null> {
  if (!/^[A-Z0-9]{3,40}$/.test(teamId)) return null;
  const [, rows] = await rawDb.$transaction([
    rawDb.$executeRaw`SELECT set_config('app.slack_team_id', ${teamId}, true)`,
    rawDb.integration.findMany({
      where: { provider: "SLACK", externalAccountId: teamId, status: { not: "DISCONNECTED" } },
      select,
      take: 2,
    }),
  ]);
  return rows.length === 1 ? rows[0]! : null;
}

/**
 * The Usage API integration a hashed ingest key belongs to, or null. The caller hashes the key
 * (SHA-256) first; the read-only policy admits the single row whose stored hash equals it.
 */
export async function findIntegrationByUsageKeyHash(
  keyHash: string,
): Promise<InboundIntegration | null> {
  if (!/^[a-f0-9]{64}$/.test(keyHash)) return null;
  const [, row] = await rawDb.$transaction([
    rawDb.$executeRaw`SELECT set_config('app.usage_key_hash', ${keyHash}, true)`,
    rawDb.integration.findFirst({
      where: { provider: "USAGE_API", ingestKeyHash: keyHash, status: { not: "DISCONNECTED" } },
      select,
    }),
  ]);
  return row;
}

/**
 * Finds an outbound message by provider message ID for inbound webhooks (e.g. Resend delivered/bounced).
 */
export async function findOutboundMessageByProviderId(
  providerMessageId: string,
): Promise<{ workspaceId: string; id: string } | null> {
  const row = await rawDb.outboundMessage.findFirst({
    where: { providerMessageId },
    select: { id: true, workspaceId: true },
  });
  return row ?? null;
}
