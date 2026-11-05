import { z } from "zod";
import type { IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { describeProviderError } from "../../errors";
import type { NormalizedTranscript } from "../../normalized";
import { requestJson } from "../../transport";

const ZOOM_API = "https://api.zoom.us";
const AUTH_URL = "https://zoom.us/oauth/authorize";
const TOKEN_URL = "https://zoom.us/oauth/token";

export const ZOOM_SCOPES = ["user:read", "cloud_recording:read", "meeting:read"] as const;

export const zoomConfig = z.record(z.string(), z.unknown()).default({});
type Cfg = z.infer<typeof zoomConfig>;

const tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
});

const userSchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

const recordingsSchema = z.object({
  meetings: z
    .array(
      z.object({
        id: z.union([z.number(), z.string()]),
        uuid: z.string(),
        topic: z.string().default("Zoom Meeting"),
        start_time: z.string(),
        duration: z.number().optional(),
        recording_files: z
          .array(
            z.object({
              id: z.string(),
              file_type: z.string(),
              download_url: z.string(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  next_page_token: z.string().optional(),
});

const participantsSchema = z.object({
  participants: z
    .array(
      z.object({
        user_email: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .default([]),
});

const transcriptContentSchema = z.object({
  transcript: z.string().default(""),
});

function auth(c: Credentials): Record<string, string> {
  if (!c.accessToken) throw new Error("Zoom has no access token");
  return { authorization: `Bearer ${c.accessToken}` };
}

function clientCredentials() {
  const cid = process.env.ZOOM_CLIENT_ID;
  const secret = process.env.ZOOM_CLIENT_SECRET;
  if (!cid || !secret) {
    if (process.env.INTEGRATIONS_TRANSPORT === "fixture" || process.env.NODE_ENV === "test")
      return { client_id: "fixture-zoom-client", client_secret: "fixture-zoom-secret" };
    throw new Error("Zoom needs ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET in the environment.");
  }
  return { client_id: cid, client_secret: secret };
}

export const zoomAdapter: IntegrationAdapter<Cfg> = {
  provider: "ZOOM",
  category: "CALLS",
  displayName: "Zoom",
  configSchema: zoomConfig,
  auth: {
    kind: "oauth2",
    scopes: ZOOM_SCOPES,
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(AUTH_URL);
      url.searchParams.set("client_id", clientCredentials().client_id);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", ZOOM_SCOPES.join(" "));
      url.searchParams.set("state", state);
      return url.toString();
    },
    async exchange(code, redirectUri, transport) {
      const { client_id, client_secret } = clientCredentials();
      const basic = Buffer.from(`${client_id}:${client_secret}`).toString("base64");
      const res = await requestJson(
        transport,
        {
          method: "POST",
          url: TOKEN_URL,
          headers: {
            authorization: `Basic ${basic}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
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
      if (!c.refreshToken) throw new Error("Zoom has no refresh token");
      const { client_id, client_secret } = clientCredentials();
      const basic = Buffer.from(`${client_id}:${client_secret}`).toString("base64");
      const res = await requestJson(
        transport,
        {
          method: "POST",
          url: TOKEN_URL,
          headers: {
            authorization: `Basic ${basic}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: c.refreshToken,
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
      const u = await requestJson(
        ctx.transport,
        {
          method: "GET",
          url: `${ZOOM_API}/v2/users/me`,
          headers: auth(ctx.credentials),
        },
        userSchema,
      );
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || u.id;
      return {
        ok: true,
        message: `Connected to Zoom (${name})`,
        externalAccountId: u.id,
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },

  describeError: (err) =>
    describeProviderError(err, "Zoom", "Reconnect Zoom from Settings › Integrations."),

  async *sync(ctx, opts) {
    let nextUrl: string | undefined = opts.cursor ?? `${ZOOM_API}/v2/users/me/recordings`;
    do {
      const res: z.infer<typeof recordingsSchema> = await requestJson(
        ctx.transport,
        { method: "GET", url: nextUrl, headers: auth(ctx.credentials) },
        recordingsSchema,
      );

      const records: NormalizedTranscript[] = [];
      for (const meeting of res.meetings) {
        // Fetch participants
        let attendeeEmails: string[] = [];
        try {
          const parts = await requestJson(
            ctx.transport,
            {
              method: "GET",
              url: `${ZOOM_API}/v2/past_meetings/${encodeURIComponent(meeting.uuid)}/participants`,
              headers: auth(ctx.credentials),
            },
            participantsSchema,
          );
          attendeeEmails = parts.participants
            .filter((p) => p.user_email && p.user_email.includes("@"))
            .map((p) => p.user_email!.toLowerCase().trim());
        } catch {
          // Non-fatal if participant list is unavailable
        }

        // Fetch transcript if transcript file exists
        let text = meeting.topic;
        const transcriptFile = meeting.recording_files.find(
          (f: { file_type: string }) => f.file_type === "TRANSCRIPT",
        );
        if (transcriptFile) {
          try {
            const transContent = await requestJson(
              ctx.transport,
              {
                method: "GET",
                url: transcriptFile.download_url,
                headers: auth(ctx.credentials),
              },
              transcriptContentSchema,
            );
            if (transContent.transcript) {
              text = transContent.transcript;
            }
          } catch {
            // Keep default topic text
          }
        }

        records.push({
          externalId: meeting.uuid,
          title: meeting.topic,
          occurredAt: new Date(meeting.start_time),
          text,
          language: "en",
          durationSec: meeting.duration ? meeting.duration * 60 : undefined,
          attendeeEmails,
        });
      }

      yield {
        kind: "transcripts",
        records,
        cursor: res.next_page_token,
      };

      nextUrl = res.next_page_token
        ? `${ZOOM_API}/v2/users/me/recordings?next_page_token=${encodeURIComponent(res.next_page_token)}`
        : undefined;
    } while (nextUrl);
  },
};
