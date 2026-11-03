import type { Integration, IntegrationProvider } from "@prisma/client";
import { businessClock, realClock, type Clock } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { logger } from "@/lib/logger";
import type { AdapterContext, IntegrationAdapter } from "./adapter";
import { adapterFor } from "./adapters";
import { needsRefresh, openCredentials, sealCredentials, type Credentials } from "./credentials";
import { transportFor, type HttpTransport } from "./transport";

/**
 * Builds an adapter context for one integration: opens its sealed credentials and, for OAuth
 * providers, refreshes an access token that is missing or about to expire, storing the new
 * tokens sealed again before anything uses them (M5 rule 3). Tokens never leave this function's
 * callers in a log line or a return value to the client.
 */
export interface ConnectionDeps {
  /** Wall-clock time for token expiry (never the business clock: tokens expire in real time). */
  clock?: Clock;
  /** The business "now" for usage windows (D-81); defaults to the business clock. */
  businessClock?: Clock;
  transport?: (provider: IntegrationProvider) => HttpTransport;
  adapter?: (provider: IntegrationProvider) => IntegrationAdapter<unknown>;
}

export class IntegrationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationUnavailableError";
  }
}

export async function loadConnection(
  ctx: TenantContext,
  integrationId: string,
  deps: ConnectionDeps = {},
  /** Refresh even if the token looks fresh (the provider said the session expired). */
  forceRefresh = false,
): Promise<{
  integration: Integration;
  adapter: IntegrationAdapter<unknown>;
  context: AdapterContext<unknown>;
}> {
  const clock = deps.clock ?? realClock;
  const db = scopedDb(ctx);
  const integration = await db.integration.findUnique({ where: { id: integrationId } });
  if (!integration) throw new IntegrationUnavailableError("This integration does not exist.");
  if (integration.status === "DISCONNECTED")
    throw new IntegrationUnavailableError("This integration is disconnected.");
  const adapter = (deps.adapter ?? adapterFor)(integration.provider);
  const transport = (deps.transport ?? transportFor)(integration.provider);
  let credentials: Credentials = openCredentials(integration.credentialsEnc);
  if (adapter.auth.kind === "oauth2" && (forceRefresh || needsRefresh(credentials, clock()))) {
    if (!credentials.refreshToken)
      throw new IntegrationUnavailableError("The connection has expired. Reconnect it.");
    credentials = { ...credentials, ...(await adapter.auth.refresh(credentials, transport)) };
    // Compare-and-set on the sealed value: a concurrent refresh by another job wins cleanly.
    await db.integration.updateMany({
      where: { id: integration.id, credentialsEnc: integration.credentialsEnc },
      data: { credentialsEnc: sealCredentials(credentials) },
    });
    logger.info(
      { workspaceId: ctx.workspaceId, integrationId, provider: integration.provider },
      "integration token refreshed",
    );
  }
  return {
    integration,
    adapter,
    context: {
      workspaceId: ctx.workspaceId,
      integrationId: integration.id,
      credentials,
      config: adapter.configSchema.parse(integration.config),
      transport,
      clock,
      businessClock: deps.businessClock ?? businessClock,
    },
  };
}
