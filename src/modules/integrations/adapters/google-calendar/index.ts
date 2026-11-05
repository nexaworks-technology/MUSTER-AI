import { z } from "zod";
import { env } from "@/lib/config/env";
import type { AdapterContext, IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { describeProviderError } from "../../errors";
import type { NormalizedBatch, NormalizedMeeting } from "../../normalized";
import { requestJson } from "../../transport";

const API = "https://www.googleapis.com";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GCAL_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
] as const;

export const googleCalendarConfig = z.record(z.string(), z.unknown()).default({});
type Cfg = z.infer<typeof googleCalendarConfig>;

const tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
});

const profileSchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  timeZone: z.string().optional(),
});

const eventListSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().default("Untitled Meeting"),
        status: z.string().default("confirmed"),
        start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
        end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
        organizer: z.object({ email: z.string().optional() }).optional(),
        attendees: z
          .array(
            z.object({
              email: z.string(),
              displayName: z.string().optional(),
              responseStatus: z.string().optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
});

function auth(c: Credentials): Record<string, string> {
  if (!c.accessToken) throw new Error("Google Calendar has no access token");
  return { authorization: `Bearer ${c.accessToken}` };
}

function clientCredentials() {
  const cid = process.env.GOOGLE_CALENDAR_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;
  if (!cid || !secret) {
    const e = env();
    if (e.INTEGRATIONS_TRANSPORT === "fixture" || e.NODE_ENV === "test")
      return { client_id: "fixture-client", client_secret: "fixture-client-secret" };
    throw new Error(
      "Google Calendar needs GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET in the environment.",
    );
  }
  return { client_id: cid, client_secret: secret };
}

export const googleCalendarAdapter: IntegrationAdapter<Cfg> = {
  provider: "GOOGLE_CALENDAR",
  category: "CALENDAR",
  displayName: "Google Calendar",
  configSchema: googleCalendarConfig,
  auth: {
    kind: "oauth2",
    scopes: GCAL_SCOPES,
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(AUTH);
      url.searchParams.set("client_id", clientCredentials().client_id);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", GCAL_SCOPES.join(" "));
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
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
      if (!c.refreshToken) throw new Error("Google Calendar has no refresh token");
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
        ...c,
        accessToken: res.access_token,
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
          url: `${API}/calendar/v3/users/me/calendarList/primary`,
          headers: auth(ctx.credentials),
        },
        profileSchema,
      );
      return {
        ok: true,
        message: `Connected to Google Calendar (${profile.id})`,
        externalAccountId: profile.id,
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },

  describeError: (err) =>
    describeProviderError(err, "Google Calendar", "Reconnect Google Calendar from Settings › Integrations."),

  async *sync(ctx, opts) {
    let pageToken = opts.cursor;
    do {
      const url = new URL(`${API}/calendar/v3/calendars/primary/events`);
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await requestJson(
        ctx.transport,
        { method: "GET", url: url.toString(), headers: auth(ctx.credentials) },
        eventListSchema,
      );

      const meetings: NormalizedMeeting[] = [];
      for (const item of res.items) {
        const startStr = item.start.dateTime ?? item.start.date;
        const endStr = item.end.dateTime ?? item.end.date;
        if (!startStr || !endStr) continue;

        const attendees = item.attendees
          .filter((a) => a.email && a.email.includes("@"))
          .map((a) => {
            let status: "NEEDS_ACTION" | "ACCEPTED" | "DECLINED" | "TENTATIVE" = "NEEDS_ACTION";
            if (a.responseStatus === "accepted") status = "ACCEPTED";
            else if (a.responseStatus === "declined") status = "DECLINED";
            else if (a.responseStatus === "tentative") status = "TENTATIVE";
            return {
              email: a.email.toLowerCase().trim(),
              name: a.displayName,
              responseStatus: status,
            };
          });

        let meetingStatus: "SCHEDULED" | "COMPLETED" | "CANCELLED" = "SCHEDULED";
        if (item.status === "cancelled") meetingStatus = "CANCELLED";

        meetings.push({
          externalId: item.id,
          title: item.summary,
          startsAt: new Date(startStr),
          endsAt: new Date(endStr),
          organizerEmail: item.organizer?.email?.toLowerCase().trim(),
          attendees,
          status: meetingStatus,
        });
      }

      yield {
        kind: "meetings",
        records: meetings,
        cursor: res.nextSyncToken ?? res.nextPageToken,
      };

      pageToken = res.nextPageToken;
    } while (pageToken);
  },
};
