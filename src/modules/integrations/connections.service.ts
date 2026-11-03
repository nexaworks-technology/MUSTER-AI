import type { IntegrationProvider } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { env } from "@/lib/config/env";
import { requirePermission } from "@/lib/auth/permissions";
import { realClock, type Clock } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import type { IntegrationAdapter } from "./adapter";
import { adapterFor } from "./adapters";
import { loadConnection } from "./connection";
import { sealCredentials, type Credentials } from "./credentials";
import { newNonce, signState, verifyState } from "./oauth";
import { PROVIDER_NAMES } from "./providers";
import { linkSlackMembers } from "./slack/service";
import { findSlackIntegrationByTeam } from "@/lib/db/inbound";
import { transportFor, type HttpTransport } from "./transport";

/**
 * Connecting and disconnecting integrations (Admin only, ARCHITECTURE §7.2). Credentials are
 * sealed before they are stored and never returned. Every connect, disconnect and failed
 * connection test is audited without any credential value (Rule 5, Rule 9).
 */
export interface ConnectDeps {
  clock?: Clock;
  transport?: (provider: IntegrationProvider) => HttpTransport;
  adapter?: (provider: IntegrationProvider) => IntegrationAdapter<unknown>;
}

export class ConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectError";
  }
}

export const redirectUriFor = (provider: IntegrationProvider) =>
  `${env().APP_URL}/api/integrations/${provider.toLowerCase()}/callback`;

/** Step 1 of OAuth: the provider's consent URL and the nonce to set as a cookie. */
export function startOAuth(actor: Actor, provider: IntegrationProvider, deps: ConnectDeps = {}) {
  requirePermission(actor, "integrations:manage");
  const adapter = (deps.adapter ?? adapterFor)(provider);
  if (adapter.auth.kind !== "oauth2")
    throw new ConnectError(`${PROVIDER_NAMES[provider]} uses a key, not a sign-in.`);
  const nonce = newNonce();
  const state = signState(
    { workspaceId: actor.workspaceId, membershipId: actor.membershipId, provider, nonce },
    deps.clock,
  );
  return {
    url: adapter.auth.authorizeUrl({ redirectUri: redirectUriFor(provider), state }),
    nonce,
    state,
  };
}

/** Step 2 of OAuth: verify state, exchange the code, store the tokens sealed. */
export async function completeOAuth(
  actor: Actor,
  provider: IntegrationProvider,
  input: { code: string; state: string; nonce: string | undefined },
  deps: ConnectDeps = {},
) {
  requirePermission(actor, "integrations:manage");
  verifyState(
    input.state,
    {
      workspaceId: actor.workspaceId,
      membershipId: actor.membershipId,
      provider,
      nonce: input.nonce,
    },
    deps.clock,
  );
  const adapter = (deps.adapter ?? adapterFor)(provider);
  if (adapter.auth.kind !== "oauth2") throw new ConnectError("This provider does not sign in.");
  const transport = (deps.transport ?? transportFor)(provider);
  const credentials = await adapter.auth.exchange(
    z.string().min(1).max(2048).parse(input.code),
    redirectUriFor(provider),
    transport,
  );
  return saveConnection(actor, provider, credentials, [...adapter.auth.scopes], deps);
}

export const apiKeyInput = z.object({
  apiKey: z.string().trim().min(8, "Paste the whole key.").max(500),
  site: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,63}$/, "Use only the site name, e.g. acme-test.")
    .optional(),
  webhookSecret: z.string().trim().min(8).max(500).optional(),
});

/** API-key providers (Stripe, Chargebee): validate the key with the provider, then store it sealed. */
export async function connectWithApiKey(
  actor: Actor,
  provider: IntegrationProvider,
  raw: unknown,
  deps: ConnectDeps = {},
) {
  requirePermission(actor, "integrations:manage");
  const input = apiKeyInput.parse(raw);
  const adapter = (deps.adapter ?? adapterFor)(provider);
  if (adapter.auth.kind !== "apiKey")
    throw new ConnectError(`${PROVIDER_NAMES[provider]} connects by signing in.`);
  const credentials: Credentials = {
    apiKey: input.apiKey,
    site: input.site,
    webhookSecret: input.webhookSecret,
  };
  const transport = (deps.transport ?? transportFor)(provider);
  try {
    await adapter.auth.validate(credentials, transport);
  } catch (err) {
    const d = adapter.describeError(err);
    await writeAudit({
      workspaceId: actor.workspaceId,
      actorType: "USER",
      actorId: actor.userId,
      action: "integration.connect_failed",
      targetType: "Integration",
      summary: `${PROVIDER_NAMES[provider]} refused the key: ${d.plain}`,
    });
    throw new ConnectError([d.plain, d.action].filter(Boolean).join(" "));
  }
  return saveConnection(actor, provider, credentials, [], deps);
}

async function saveConnection(
  actor: Actor,
  provider: IntegrationProvider,
  credentials: Credentials,
  scopes: string[],
  deps: ConnectDeps,
) {
  const db = scopedDb(actor);
  const existing = await db.integration.findUnique({
    where: { workspaceId_provider: { workspaceId: actor.workspaceId, provider } },
  });
  const sealed = sealCredentials(credentials);
  const integration = await db.$tenantTransaction(async (tx) => {
    // Reconnecting keeps the first connectedAt: CRM primacy (Q-32) does not move on a reconnect.
    const row = existing
      ? await tx.integration.update({
          where: { id: existing.id },
          data: {
            status: "CONNECTED",
            credentialsEnc: sealed,
            scopes,
            disconnectedAt: null,
            lastErrorPlain: null,
          },
        })
      : await tx.integration.create({
          data: {
            workspaceId: actor.workspaceId,
            provider,
            credentialsEnc: sealed,
            scopes,
            connectedByMembershipId: actor.membershipId,
            connectedAt: (deps.clock ?? realClock)(),
          },
        });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: existing ? "integration.reconnected" : "integration.connected",
        targetType: "Integration",
        targetId: row.id,
        summary: `${existing ? "Reconnected" : "Connected"} ${PROVIDER_NAMES[provider]} (read-only)`,
        after: { provider, scopes, writeBackEnabled: row.writeBackEnabled },
      },
      tx,
    );
    return row;
  });
  // Record which provider account was connected, so webhooks and the UI can name it.
  const check = await testConnection(actor, integration.id, deps).catch(() => null);
  if (provider === "SLACK" && check?.ok) await linkSlackMembers(actor, deps).catch(() => null); // shown as "0 linked" if it fails
  return { integrationId: integration.id, check };
}

/** "Test connection": a cheap read; the plain result is stored as the last error when it fails. */
export async function testConnection(actor: Actor, integrationId: string, deps: ConnectDeps = {}) {
  requirePermission(actor, "integrations:manage");
  const db = scopedDb(actor);
  if (!(await db.integration.findUnique({ where: { id: integrationId }, select: { id: true } })))
    throw new ConnectError("This integration does not exist.");
  let result: { ok: boolean; message: string; externalAccountId?: string };
  try {
    const { adapter, context } = await loadConnection(actor, integrationId, deps);
    try {
      result = await adapter.testConnection(context);
    } catch (err) {
      const d = adapter.describeError(err);
      result = { ok: false, message: [d.plain, d.action].filter(Boolean).join(" ") };
    }
  } catch (err) {
    result = {
      ok: false,
      message: err instanceof Error ? err.message : "The connection could not be opened.",
    };
  }
  await db.integration.update({
    where: { id: integrationId },
    data: result.ok
      ? { status: "CONNECTED", lastErrorPlain: null, externalAccountId: result.externalAccountId }
      : { status: "ERROR", lastErrorPlain: result.message },
  });
  // A Slack team must belong to exactly one workspace, or clicks could not be routed (D-93).
  const row = await db.integration.findUniqueOrThrow({
    where: { id: integrationId },
    select: { provider: true, externalAccountId: true },
  });
  if (
    result.ok &&
    row.provider === "SLACK" &&
    row.externalAccountId &&
    !(await findSlackIntegrationByTeam(row.externalAccountId))
  ) {
    result = {
      ok: false,
      message:
        "This Slack workspace is already connected to another NexaWorks workspace, so Approve and Reject from Slack are off until it is disconnected there.",
    };
    await db.integration.update({
      where: { id: integrationId },
      data: { status: "ERROR", lastErrorPlain: result.message },
    });
  }
  return { ok: result.ok, message: result.message };
}

/** Disconnect: wipes the credentials (DB CHECK) and turns write-back off. History stays. */
export async function disconnect(actor: Actor, integrationId: string) {
  requirePermission(actor, "integrations:manage");
  const db = scopedDb(actor);
  await db.$tenantTransaction(async (tx) => {
    const row = await tx.integration.findUnique({ where: { id: integrationId } });
    if (!row) throw new ConnectError("This integration does not exist.");
    await tx.integration.update({
      where: { id: integrationId },
      data: {
        status: "DISCONNECTED",
        credentialsEnc: null,
        writeBackEnabled: false,
        writeBackFields: [],
        disconnectedAt: realClock(),
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "integration.disconnected",
        targetType: "Integration",
        targetId: integrationId,
        summary: `Disconnected ${PROVIDER_NAMES[row.provider]}; its saved credentials were deleted`,
      },
      tx,
    );
  });
}
