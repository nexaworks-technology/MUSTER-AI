import type { IntegrationProvider, Prisma } from "@prisma/client";
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
import { openCredentials, sealCredentials, type Credentials } from "./credentials";
import { newNonce, signState, verifyState } from "./oauth";
import { PROVIDER_NAMES } from "./providers";
import { linkSlackMembers } from "./slack/service";
import { findSlackIntegrationByTeam } from "@/lib/db/inbound";
import { transportFor, type HttpTransport } from "./transport";
import { PRODUCT_NAME } from "@/config/product";

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

/** Providers connected with the key form on Settings › Integrations (the Usage API has its own). */
export const API_KEY_FORM_PROVIDERS = [
  "STRIPE",
  "CHARGEBEE",
  "MIXPANEL",
  "AMPLITUDE",
  "ZENDESK",
  "FRESHDESK",
] as const satisfies readonly IntegrationProvider[];

/**
 * "https://Acme.zendesk.com/" → "acme": people paste the whole address; the provider's own
 * suffix and any scheme or path are dropped. Anything else is left for the format check.
 */
export function normalizeSite(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.(chargebee|zendesk|freshdesk)\.com$/, "");
}

export const apiKeyInput = z.object({
  apiKey: z.string().trim().min(8, "Paste the whole key.").max(500),
  site: z
    .string()
    .transform(normalizeSite)
    .pipe(z.string().regex(/^[a-z0-9-]{1,63}$/, "Use only the site name, e.g. acme-test."))
    .optional(),
  webhookSecret: z.string().trim().min(8).max(500).optional(),
  /** Mixpanel: the service account's user name. Amplitude: the project API key. */
  username: z.string().trim().min(1).max(200).optional(),
  /** The connection's own settings (project id, region, property names); checked by the adapter. */
  config: z.record(z.string(), z.unknown()).optional(),
});

/** Providers whose key comes with a second half. */
const NEEDS_USERNAME: Partial<Record<IntegrationProvider, string>> = {
  MIXPANEL: "Enter the service account's user name.",
  AMPLITUDE: "Enter the project's API key as well as its secret key.",
  ZENDESK: "Enter the Zendesk admin email the API token belongs to.",
};

/** Providers whose address needs the account's own name; checked before any request. */
const NEEDS_SITE: Partial<Record<IntegrationProvider, string>> = {
  CHARGEBEE: "Enter your Chargebee site name.",
  ZENDESK: "Enter your Zendesk subdomain (the acme in acme.zendesk.com).",
  FRESHDESK: "Enter your Freshdesk domain (the acme in acme.freshdesk.com).",
};

/** Second halves that must have a particular shape. */
function checkUsername(provider: IntegrationProvider, username: string | undefined) {
  if (provider === "ZENDESK" && username && !z.email().safeParse(username).success)
    throw new ConnectError("The Zendesk admin email does not look like an email address.");
}

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
  if (NEEDS_SITE[provider] && !input.site) throw new ConnectError(NEEDS_SITE[provider]!);
  if (NEEDS_USERNAME[provider] && !input.username)
    throw new ConnectError(NEEDS_USERNAME[provider]!);
  checkUsername(provider, input.username);
  const settings = adapter.configSchema.safeParse(input.config ?? {});
  if (!settings.success)
    throw new ConnectError(
      settings.error.issues[0]?.message ?? "Check the settings and try again.",
    );
  const credentials: Credentials = {
    apiKey: input.apiKey,
    username: input.username,
    site: input.site,
    webhookSecret: input.webhookSecret,
  };
  const transport = (deps.transport ?? transportFor)(provider);
  try {
    await adapter.auth.validate(credentials, transport, settings.data);
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
  return saveConnection(actor, provider, credentials, [], deps, settings.data);
}

export const replaceKeyInput = apiKeyInput.pick({ apiKey: true });

/**
 * Replace the key of a connected key-based integration in place (CONNECTOR-LIVE.md, B1 finding 3).
 * The new key is validated with the provider together with the connection's existing settings
 * (site, user name, webhook secret, config). Only an accepted key is sealed over the old one; the
 * integration row, connectedAt, sync history and synced records are untouched. A refused key
 * changes nothing and is audited, never echoed.
 */
export async function replaceApiKey(
  actor: Actor,
  integrationId: string,
  raw: unknown,
  deps: ConnectDeps = {},
) {
  requirePermission(actor, "integrations:manage");
  const { apiKey } = replaceKeyInput.parse(raw);
  const db = scopedDb(actor);
  const row = await db.integration.findUnique({ where: { id: integrationId } });
  if (!row) throw new ConnectError("This integration does not exist.");
  const name = PROVIDER_NAMES[row.provider];
  if (row.status === "DISCONNECTED" || !row.credentialsEnc)
    throw new ConnectError(`${name} is not connected. Connect it with a key first.`);
  const adapter = (deps.adapter ?? adapterFor)(row.provider);
  if (
    adapter.auth.kind !== "apiKey" ||
    !(API_KEY_FORM_PROVIDERS as readonly string[]).includes(row.provider)
  )
    throw new ConnectError(`${name} does not connect with a key.`);
  const credentials: Credentials = { ...openCredentials(row.credentialsEnc), apiKey };
  const settings = adapter.configSchema.safeParse(row.config ?? {});
  try {
    await adapter.auth.validate(
      credentials,
      (deps.transport ?? transportFor)(row.provider),
      settings.success ? settings.data : undefined,
    );
  } catch (err) {
    const d = adapter.describeError(err);
    await writeAudit({
      workspaceId: actor.workspaceId,
      actorType: "USER",
      actorId: actor.userId,
      action: "integration.key_replace_failed",
      targetType: "Integration",
      targetId: row.id,
      summary: `${name} refused the new key, so the saved key was kept: ${d.plain}`,
    });
    throw new ConnectError(
      [d.plain, d.action, "The saved key was kept."].filter(Boolean).join(" "),
    );
  }
  await db.$tenantTransaction(async (tx) => {
    await tx.integration.update({
      where: { id: row.id },
      data: {
        credentialsEnc: sealCredentials(credentials),
        status: "CONNECTED",
        lastErrorPlain: null,
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "integration.key_replaced",
        targetType: "Integration",
        targetId: row.id,
        summary: `Replaced the ${name} key after ${name} accepted it; synced records were kept`,
      },
      tx,
    );
  });
  const check = await testConnection(actor, row.id, deps).catch(() => null);
  return { integrationId: row.id, check };
}

async function saveConnection(
  actor: Actor,
  provider: IntegrationProvider,
  credentials: Credentials,
  scopes: string[],
  deps: ConnectDeps,
  config?: unknown,
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
            ...(config === undefined ? {} : { config: config as Prisma.InputJsonObject }),
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
            ...(config === undefined ? {} : { config: config as Prisma.InputJsonObject }),
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
      message: `This Slack workspace is already connected to another ${PRODUCT_NAME} workspace, so Approve and Reject from Slack are off until it is disconnected there.`,
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
        // The Usage API's ingest key goes with the connection: a disconnected one accepts nothing.
        ingestKeyHash: null,
        ingestKeyLast4: null,
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
