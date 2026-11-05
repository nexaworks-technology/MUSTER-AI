import { z } from "zod";
import type { IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { describeProviderError } from "../../errors";
import type { NormalizedTranscript } from "../../normalized";
import { requestJson } from "../../transport";

const GONG_API = "https://api.gong.io";

export const gongConfig = z.record(z.string(), z.unknown()).default({});
type Cfg = z.infer<typeof gongConfig>;

const userResponse = z.object({
  id: z.string(),
  emailAddress: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

const callsResponse = z.object({
  calls: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().default("Gong Call"),
        started: z.string(),
        duration: z.number().optional(),
        parties: z
          .array(
            z.object({
              emailAddress: z.string().optional(),
              name: z.string().optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  cursor: z.string().optional(),
});

const transcriptResponse = z.object({
  callTranscripts: z
    .array(
      z.object({
        callId: z.string(),
        transcript: z
          .array(
            z.object({
              speakerId: z.string().optional(),
              sentences: z
                .array(
                  z.object({
                    text: z.string(),
                  }),
                )
                .default([]),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

function auth(c: Credentials): Record<string, string> {
  if (c.username && c.apiKey) {
    const creds = Buffer.from(`${c.username}:${c.apiKey}`).toString("base64");
    return { authorization: `Basic ${creds}` };
  }
  if (c.apiKey) {
    return { authorization: `Bearer ${c.apiKey}` };
  }
  throw new Error("Gong has no credentials");
}

export const gongAdapter: IntegrationAdapter<Cfg> = {
  provider: "GONG",
  category: "CALLS",
  displayName: "Gong",
  configSchema: gongConfig,
  auth: {
    kind: "apiKey",
    async validate(credentials, transport) {
      await requestJson(
        transport,
        {
          method: "GET",
          url: `${GONG_API}/v2/users/current`,
          headers: auth(credentials),
        },
        userResponse,
      );
    },
  },

  async testConnection(ctx) {
    try {
      const u = await requestJson(
        ctx.transport,
        {
          method: "GET",
          url: `${GONG_API}/v2/users/current`,
          headers: auth(ctx.credentials),
        },
        userResponse,
      );
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.emailAddress || u.id;
      return {
        ok: true,
        message: `Connected to Gong (${name})`,
        externalAccountId: u.id,
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },

  describeError: (err) =>
    describeProviderError(err, "Gong", "Enter your Gong access key and secret key."),

  async *sync(ctx, opts) {
    let nextUrl: string | undefined = opts.cursor ?? `${GONG_API}/v2/calls`;
    do {
      const res: z.infer<typeof callsResponse> = await requestJson(
        ctx.transport,
        { method: "GET", url: nextUrl, headers: auth(ctx.credentials) },
        callsResponse,
      );

      if (res.calls.length === 0) break;

      const callIds = res.calls.map((c) => c.id);

      // Fetch transcripts for these calls
      const transRes = await requestJson(
        ctx.transport,
        {
          method: "POST",
          url: `${GONG_API}/v2/calls/transcript`,
          headers: { ...auth(ctx.credentials), "content-type": "application/json" },
          body: JSON.stringify({ filter: { callIds } }),
        },
        transcriptResponse,
      );

      const transcriptByCallId = new Map<string, string>();
      for (const ct of transRes.callTranscripts) {
        const text = ct.transcript
          .flatMap((entry) => entry.sentences.map((s) => s.text))
          .filter(Boolean)
          .join(" ");
        transcriptByCallId.set(ct.callId, text);
      }

      const records: NormalizedTranscript[] = [];
      for (const call of res.calls) {
        const text = transcriptByCallId.get(call.id) || call.title;
        const attendeeEmails = call.parties
          .filter((p) => p.emailAddress && p.emailAddress.includes("@"))
          .map((p) => p.emailAddress!.toLowerCase().trim());

        records.push({
          externalId: call.id,
          title: call.title,
          occurredAt: new Date(call.started),
          text,
          language: "en",
          durationSec: call.duration,
          attendeeEmails,
        });
      }

      yield {
        kind: "transcripts",
        records,
        cursor: res.cursor,
      };

      nextUrl = res.cursor
        ? `${GONG_API}/v2/calls?cursor=${encodeURIComponent(res.cursor)}`
        : undefined;
    } while (nextUrl);
  },
};
