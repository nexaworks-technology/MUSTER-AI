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

/** The Slack integration connected to a Slack team (workspace), or null. */
export async function findSlackIntegrationByTeam(
  teamId: string,
): Promise<InboundIntegration | null> {
  if (!/^[A-Z0-9]{3,40}$/.test(teamId)) return null;
  const [, row] = await rawDb.$transaction([
    rawDb.$executeRaw`SELECT set_config('app.slack_team_id', ${teamId}, true)`,
    rawDb.integration.findFirst({
      where: { provider: "SLACK", externalAccountId: teamId, status: { not: "DISCONNECTED" } },
      select,
    }),
  ]);
  return row;
}
