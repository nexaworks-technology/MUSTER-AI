import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "@/lib/config/env";
import type { AdapterContext, IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { describeProviderError } from "../../errors";
import { ProviderHttpError, requestJson, type HttpTransport } from "../../transport";

/**
 * Slack (OAuth bot). Internal only in M5 (founder D4): it posts approval requests, big signals and
 * a morning digest to the team's own Slack, and receives Approve/Reject clicks. It reads no
 * customer records, so it never syncs. Slack answers most errors with HTTP 200 and `ok: false`;
 * those are turned into the same HTTP errors every adapter uses, so describeError reads alike.
 */
const API = "https://slack.com/api";
export const SLACK_SCOPES = ["chat:write", "im:write", "users:read", "users:read.email"] as const;
const SIGNATURE_WINDOW_SECONDS = 300;

type Cfg = Record<string, never>;

const ERROR_STATUS: Record<string, number> = {
  invalid_auth: 401,
  not_authed: 401,
  token_revoked: 401,
  account_inactive: 401,
  missing_scope: 403,
  ratelimited: 429,
};

const slackResponse = z.object({ ok: z.boolean(), error: z.string().optional() }).passthrough();

/** One Web API call. `ok: false` becomes a ProviderHttpError; the bot token never leaves the header. */
export async function slackApi<T extends z.ZodType>(
  t: HttpTransport,
  token: string | undefined,
  method: string,
  body: Record<string, unknown>,
  schema: T,
): Promise<z.infer<T>> {
  const res = await requestJson(
    t,
    {
      method: "POST",
      url: `${API}/${method}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    },
    slackResponse,
  );
  if (!res.ok) throw new ProviderHttpError(ERROR_STATUS[res.error ?? ""] ?? 400);
  const parsed = schema.safeParse(res);
  if (!parsed.success) throw new ProviderHttpError(502);
  return parsed.data;
}

const oauthAccess = z.object({
  ok: z.literal(true),
  access_token: z.string().min(1),
  team: z.object({ id: z.string(), name: z.string().optional() }),
  bot_user_id: z.string().optional(),
});

export const slackMember = z.object({
  id: z.string(),
  deleted: z.boolean().optional(),
  is_bot: z.boolean().optional(),
  is_email_confirmed: z.boolean().optional(),
  profile: z.object({ email: z.string().optional(), real_name: z.string().optional() }).optional(),
});
export const usersPage = z.object({
  ok: z.literal(true),
  members: z.array(slackMember),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});

function clientCredentials() {
  const e = env();
  if (!e.SLACK_CLIENT_ID || !e.SLACK_CLIENT_SECRET) {
    if (e.INTEGRATIONS_TRANSPORT === "fixture" || e.NODE_ENV === "test")
      return { client_id: "fixture-client", client_secret: "fixture-client-secret" };
    throw new Error("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are not set");
  }
  return { client_id: e.SLACK_CLIENT_ID, client_secret: e.SLACK_CLIENT_SECRET };
}

/**
 * Slack's request signing: `v0=` + HMAC-SHA256(signing secret, `v0:<ts>:<raw body>`), and the
 * timestamp must be within five minutes of now (replays are refused).
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
  secret: string,
  now: Date,
): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > SIGNATURE_WINDOW_SECONDS) return false;
  const want = Buffer.from(
    `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`,
  );
  const got = Buffer.from(signature);
  return got.length === want.length && timingSafeEqual(got, want);
}

export const slackAdapter: IntegrationAdapter<Cfg> = {
  provider: "SLACK",
  category: "CHAT",
  displayName: "Slack",
  configSchema: z.object({}).strip() as unknown as z.ZodType<Cfg>,
  auth: {
    kind: "oauth2",
    scopes: SLACK_SCOPES,
    authorizeUrl({ redirectUri, state }) {
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", clientCredentials().client_id);
      url.searchParams.set("scope", SLACK_SCOPES.join(","));
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },
    async exchange(code, redirectUri, transport): Promise<Credentials> {
      const r = await requestJson(
        transport,
        {
          method: "POST",
          url: `${API}/oauth.v2.access`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            ...clientCredentials(),
            code,
            redirect_uri: redirectUri,
          }).toString(),
        },
        slackResponse,
      );
      if (!r.ok) throw new ProviderHttpError(ERROR_STATUS[r.error ?? ""] ?? 400);
      const ok = oauthAccess.parse(r);
      // Bot tokens do not expire (token rotation is off for this app).
      return { accessToken: ok.access_token };
    },
    async refresh() {
      throw new ProviderHttpError(401);
    },
  },
  async testConnection(ctx: AdapterContext<Cfg>) {
    const r = await slackApi(
      ctx.transport,
      ctx.credentials.accessToken,
      "auth.test",
      {},
      z.object({ team_id: z.string(), team: z.string().optional() }).passthrough(),
    );
    return {
      ok: true,
      message: `Connected to the Slack workspace ${r.team ?? r.team_id}. It posts approvals, big signals and a morning digest.`,
      externalAccountId: r.team_id,
    };
  },
  // Slack carries no customer records: nothing to sync.
   
  async *sync() {
    return;
  },
  describeError: (err) =>
    describeProviderError(err, "Slack", "Reconnect Slack from Settings › Integrations."),
};
