import { z } from "zod";
import { env } from "@/lib/config/env";
import type { AdapterContext, IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { describeProviderError } from "../../errors";
import type { NormalizedBatch, NormalizedMeeting } from "../../normalized";
import { requestJson } from "../../transport";

const GRAPH_API = "https://graph.microsoft.com";
const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export const MS_CALENDAR_SCOPES = [
  "offline_access",
  "User.Read",
  "Calendars.Read",
] as const;

export const microsoftCalendarConfig = z.record(z.string(), z.unknown()).default({});
type Cfg = z.infer<typeof microsoftCalendarConfig>;

const tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
});

const profileSchema = z.object({
  id: z.string(),
  userPrincipalName: z.string().optional(),
  mail: z.string().optional(),
});

const eventListSchema = z.object({
  value: z
    .array(
      z.object({
        id: z.string(),
        subject: z.string().default("Untitled Meeting"),
        isCancelled: z.boolean().default(false),
        start: z.object({ dateTime: z.string() }),
        end: z.object({ dateTime: z.string() }),
        organizer: z
          .object({
            emailAddress: z.object({ address: z.string().optional(), name: z.string().optional() }),
          })
          .optional(),
        attendees: z
          .array(
            z.object({
              type: z.string().optional(),
              status: z.object({ response: z.string().optional() }).optional(),
              emailAddress: z.object({ address: z.string().optional(), name: z.string().optional() }),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});

function auth(c: Credentials): Record<string, string> {
  if (!c.accessToken) throw new Error("Microsoft Graph has no access token");
  return { authorization: `Bearer ${c.accessToken}` };
}

function clientCredentials() {
  const cid = process.env.MICROSOFT_CALENDAR_CLIENT_ID ?? process.env.MICROSOFT_CLIENT_ID;
  const secret = process.env.MICROSOFT_CALENDAR_CLIENT_SECRET ?? process.env.MICROSOFT_CLIENT_SECRET;
  if (!cid || !secret) {
    const e = env();
    if (e.INTEGRATIONS_TRANSPORT === "fixture" || e.NODE_ENV === "test")
      return { client_id: "fixture-ms-client", client_secret: "fixture-ms-secret" };
    throw new Error(
      "Microsoft Calendar needs MICROSOFT_CALENDAR_CLIENT_ID and MICROSOFT_CALENDAR_CLIENT_SECRET in the environment.",
    );
  }
  return { client_id: cid, client_secret: secret };
}

export const microsoftCalendarAdapter: IntegrationAdapter<Cfg> = {
  provider: "MICROSOFT_CALENDAR",
  category: "CALENDAR",
  displayName: "Outlook Calendar",
  configSchema: microsoftCalendarConfig,
  auth: {
    kind: "oauth2",
    scopes: MS_CALENDAR_SCOPES,
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(AUTH_URL);
      url.searchParams.set("client_id", clientCredentials().client_id);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", MS_CALENDAR_SCOPES.join(" "));
      url.searchParams.set("response_mode", "query");
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
            client_id: clientCredentials().client_id,
            client_secret: clientCredentials().client_secret,
            redirect_uri: redirectUri,
            code,
            scope: MS_CALENDAR_SCOPES.join(" "),
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
      if (!c.refreshToken) throw new Error("Microsoft Graph has no refresh token");
      const res = await requestJson(
        transport,
        {
          method: "POST",
          url: TOKEN_URL,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: clientCredentials().client_id,
            client_secret: clientCredentials().client_secret,
            refresh_token: c.refreshToken,
            scope: MS_CALENDAR_SCOPES.join(" "),
          }).toString(),
        },
        tokens,
      );
      return {
        ...c,
        accessToken: res.access_token,
        refreshToken: res.refresh_token ?? c.refreshToken,
        expiresAt: new Date(Date.now() + res.expires_in * 1000).toISOString(),
      };
    },
  },

  async testConnection(ctx) {
    try {
      const profile = await requestJson(
        ctx.transport,
        {
          method: "GET",
          url: `${GRAPH_API}/v1.0/me`,
          headers: auth(ctx.credentials),
        },
        profileSchema,
      );
      const email = profile.mail ?? profile.userPrincipalName ?? profile.id;
      return {
        ok: true,
        message: `Connected to Outlook Calendar (${email})`,
        externalAccountId: profile.id,
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },

  describeError: (err) =>
    describeProviderError(err, "Outlook Calendar", "Reconnect Outlook Calendar from Settings › Integrations."),

  async *sync(ctx, opts) {
    let nextUrl: string | undefined = opts.cursor ?? `${GRAPH_API}/v1.0/me/events`;
    do {
      const res: z.infer<typeof eventListSchema> = await requestJson(
        ctx.transport,
        { method: "GET", url: nextUrl, headers: auth(ctx.credentials) },
        eventListSchema,
      );

      const meetings: NormalizedMeeting[] = [];
      for (const item of res.value) {
        const startStr = item.start.dateTime;
        const endStr = item.end.dateTime;
        if (!startStr || !endStr) continue;

        const attendees = item.attendees
          .filter((a) => a.emailAddress?.address && a.emailAddress.address.includes("@"))
          .map((a) => {
            const resp = a.status?.response?.toLowerCase();
            let status: "NEEDS_ACTION" | "ACCEPTED" | "DECLINED" | "TENTATIVE" = "NEEDS_ACTION";
            if (resp === "accepted") status = "ACCEPTED";
            else if (resp === "declined") status = "DECLINED";
            else if (resp === "tentativelyaccepted") status = "TENTATIVE";
            return {
              email: a.emailAddress.address!.toLowerCase().trim(),
              name: a.emailAddress.name,
              responseStatus: status,
            };
          });

        let meetingStatus: "SCHEDULED" | "COMPLETED" | "CANCELLED" = "SCHEDULED";
        if (item.isCancelled) meetingStatus = "CANCELLED";

        meetings.push({
          externalId: item.id,
          title: item.subject,
          startsAt: new Date(startStr.endsWith("Z") ? startStr : `${startStr}Z`),
          endsAt: new Date(endStr.endsWith("Z") ? endStr : `${endStr}Z`),
          organizerEmail: item.organizer?.emailAddress?.address?.toLowerCase().trim(),
          attendees,
          status: meetingStatus,
        });
      }

      yield {
        kind: "meetings",
        records: meetings,
        cursor: res["@odata.deltaLink"] ?? res["@odata.nextLink"],
      };

      nextUrl = res["@odata.nextLink"];
    } while (nextUrl);
  },
};
