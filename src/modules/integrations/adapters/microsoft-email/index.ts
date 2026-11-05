import { z } from "zod";
import { env } from "@/lib/config/env";
import type { AdapterContext, IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { describeProviderError } from "../../errors";
import type { NormalizedBatch, NormalizedMail } from "../../normalized";
import { requestJson } from "../../transport";

const API = "https://graph.microsoft.com";
const AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export const GRAPH_SCOPES = [
  "Mail.Read",
  "Mail.ReadWrite",
  "offline_access",
  "User.Read",
] as const;

export const microsoftEmailConfig = z.record(z.string(), z.unknown()).default({});
type Cfg = z.infer<typeof microsoftEmailConfig>;

const tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
});

const userSchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  mail: z.string().nullable().optional(),
  userPrincipalName: z.string(),
});

const recipientSchema = z.object({
  emailAddress: z.object({
    address: z.string(),
    name: z.string().optional(),
  }),
});

const graphMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string().optional(),
  sentDateTime: z.string(),
  subject: z.string().nullable().optional(),
  bodyPreview: z.string().optional(),
  body: z
    .object({
      contentType: z.string().optional(),
      content: z.string().optional(),
    })
    .optional(),
  from: recipientSchema.optional(),
  toRecipients: z.array(recipientSchema).default([]),
  isDraft: z.boolean().optional(),
});

const deltaResponseSchema = z.object({
  value: z.array(graphMessageSchema).default([]),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});

function auth(c: Credentials): Record<string, string> {
  if (!c.accessToken) throw new Error("Outlook has no access token");
  return { authorization: `Bearer ${c.accessToken}` };
}

function clientCredentials() {
  const e = env();
  if (!e.MICROSOFT_EMAIL_CLIENT_ID || !e.MICROSOFT_EMAIL_CLIENT_SECRET) {
    if (e.INTEGRATIONS_TRANSPORT === "fixture" || e.NODE_ENV === "test")
      return { client_id: "fixture-client", client_secret: "fixture-client-secret" };
    throw new Error("MICROSOFT_EMAIL_CLIENT_ID and MICROSOFT_EMAIL_CLIENT_SECRET are not set");
  }
  return { client_id: e.MICROSOFT_EMAIL_CLIENT_ID, client_secret: e.MICROSOFT_EMAIL_CLIENT_SECRET };
}

export const microsoftEmailAdapter: IntegrationAdapter<Cfg> = {
  provider: "MICROSOFT_EMAIL",
  category: "EMAIL",
  displayName: "Outlook",
  configSchema: microsoftEmailConfig,
  auth: {
    kind: "oauth2",
    scopes: GRAPH_SCOPES,
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(AUTH);
      url.searchParams.set("client_id", clientCredentials().client_id);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", GRAPH_SCOPES.join(" "));
      url.searchParams.set("state", state);
      return url.toString();
    },
    async exchange(code, redirectUri, transport) {
      const res = await requestJson(
        transport,
        {
          method: "POST",
          url: TOKEN_URL,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            ...clientCredentials(),
            redirect_uri: redirectUri,
            code,
          }).toString(),
        },
        tokens,
      );
      return {
        accessToken: res.access_token,
        refreshToken: res.refresh_token,
        expiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
      };
    },
    async refresh(c, transport) {
      if (!c.refreshToken) throw new Error("Outlook has no refresh token");
      const res = await requestJson(
        transport,
        {
          method: "POST",
          url: TOKEN_URL,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            ...clientCredentials(),
            refresh_token: c.refreshToken,
          }).toString(),
        },
        tokens,
      );
      return {
        accessToken: res.access_token,
        refreshToken: res.refresh_token ?? c.refreshToken,
        expiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
      };
    },
  },
  async testConnection(ctx: AdapterContext<Cfg>) {
    const user = await requestJson(
      ctx.transport,
      {
        method: "GET",
        url: `${API}/v1.0/me`,
        headers: auth(ctx.credentials),
      },
      userSchema,
    );
    const email = user.mail || user.userPrincipalName;
    return {
      ok: true,
      message: `Connected to Outlook (${email}). Read-only.`,
      externalAccountId: email,
    };
  },
  async *sync(ctx, opts): AsyncGenerator<NormalizedBatch> {
    const { transport: t, credentials: c } = ctx;
    const user = await requestJson(
      t,
      {
        method: "GET",
        url: `${API}/v1.0/me`,
        headers: auth(c),
      },
      userSchema,
    );
    const myEmail = (user.mail || user.userPrincipalName).toLowerCase();

    const url = new URL("/v1.0/me/mailFolders/inbox/messages/delta", API);
    if (opts.kind === "INCREMENTAL" && opts.cursor) {
      url.searchParams.set("$deltatoken", opts.cursor);
    }

    const delta = await requestJson(
      t,
      {
        method: "GET",
        url: url.toString(),
        headers: auth(c),
      },
      deltaResponseSchema,
    );

    const records: NormalizedMail[] = [];
    for (const msg of delta.value) {
      if (msg.isDraft) continue;

      const fromAddress = msg.from?.emailAddress?.address?.trim().toLowerCase();
      const toAddresses = msg.toRecipients
        .map((r) => r.emailAddress?.address?.trim().toLowerCase())
        .filter((addr): addr is string => Boolean(addr && addr.includes("@")));

      if (!fromAddress || toAddresses.length === 0) continue;

      const isOutbound = fromAddress === myEmail;
      const bodyText = msg.body?.content || msg.bodyPreview || "No body content";
      const sentAt = new Date(msg.sentDateTime);

      records.push({
        externalId: msg.id,
        threadExternalId: msg.conversationId,
        direction: isOutbound ? "OUTBOUND" : "INBOUND",
        fromAddress,
        fromName: msg.from?.emailAddress?.name,
        toAddresses,
        subject: msg.subject ?? "",
        bodyText,
        sentAt: isNaN(sentAt.getTime()) ? new Date() : sentAt,
      });
    }

    yield {
      kind: "mail",
      records,
    };

    let deltaToken = String(ctx.clock().getTime());
    if (delta["@odata.deltaLink"]) {
      const match = /\$deltatoken=([^&]+)/.exec(delta["@odata.deltaLink"]);
      if (match) deltaToken = match[1]!;
    }

    yield {
      kind: "mail",
      records: [],
      cursor: deltaToken,
    };
  },
  writeBack: {
    fields: [{ key: "draft", label: "Draft in mailbox" }],
    async push(ctx, change) {
      if (change.field !== "draft") throw new Error("Outlook writes only drafts");
      const created = await requestJson(
        ctx.transport,
        {
          method: "POST",
          url: `${API}/v1.0/me/messages`,
          headers: { ...auth(ctx.credentials), "content-type": "application/json" },
          body: JSON.stringify({
            conversationId: change.externalId,
            subject: "Draft",
            isDraft: true,
            body: {
              contentType: "Text",
              content: change.value,
            },
          }),
        },
        z.object({ id: z.string() }),
      );
      return { externalId: created.id };
    },
  },
  describeError: (err) =>
    describeProviderError(err, "Outlook", "Reconnect Outlook from Settings › Integrations."),
};
