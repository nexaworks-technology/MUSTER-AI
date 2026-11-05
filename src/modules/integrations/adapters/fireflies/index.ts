import { z } from "zod";
import type { IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { describeProviderError } from "../../errors";
import type { NormalizedTranscript } from "../../normalized";
import { requestJson } from "../../transport";

const FIREFLIES_GRAPHQL = "https://api.fireflies.ai/graphql";

export const firefliesConfig = z.record(z.string(), z.unknown()).default({});
type Cfg = z.infer<typeof firefliesConfig>;

const userQueryResponse = z.object({
  data: z.object({
    user: z.object({
      id: z.string(),
      email: z.string().optional(),
      name: z.string().optional(),
    }),
  }),
});

const transcriptsQueryResponse = z.object({
  data: z.object({
    transcripts: z.array(
      z.object({
        id: z.string(),
        title: z.string().default("Call Transcript"),
        date: z.union([z.number(), z.string()]),
        duration: z.number().optional(),
        participants: z.array(z.string()).default([]),
        sentences: z
          .array(
            z.object({
              speaker_name: z.string().default("Speaker"),
              text: z.string(),
            }),
          )
          .default([]),
      }),
    ),
  }),
});

function auth(c: Credentials): Record<string, string> {
  if (!c.apiKey) throw new Error("Fireflies has no API key");
  return {
    authorization: `Bearer ${c.apiKey}`,
    "content-type": "application/json",
  };
}

export const firefliesAdapter: IntegrationAdapter<Cfg> = {
  provider: "FIREFLIES",
  category: "CALLS",
  displayName: "Fireflies.ai",
  configSchema: firefliesConfig,
  auth: {
    kind: "apiKey",
    async validate(credentials, transport) {
      await requestJson(
        transport,
        {
          method: "POST",
          url: FIREFLIES_GRAPHQL,
          headers: auth(credentials),
          body: JSON.stringify({ query: "{ user { id email name } }" }),
        },
        userQueryResponse,
      );
    },
  },

  async testConnection(ctx) {
    try {
      const res = await requestJson(
        ctx.transport,
        {
          method: "POST",
          url: FIREFLIES_GRAPHQL,
          headers: auth(ctx.credentials),
          body: JSON.stringify({ query: "{ user { id email name } }" }),
        },
        userQueryResponse,
      );
      const u = res.data.user;
      return {
        ok: true,
        message: `Connected to Fireflies (${u.name ?? u.email ?? u.id})`,
        externalAccountId: u.id,
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },

  describeError: (err) =>
    describeProviderError(err, "Fireflies", "Enter a valid Fireflies API key."),

  async *sync(ctx) {
    const res = await requestJson(
      ctx.transport,
      {
        method: "POST",
        url: FIREFLIES_GRAPHQL,
        headers: auth(ctx.credentials),
        body: JSON.stringify({
          query: `query {
            transcripts {
              id
              title
              date
              duration
              participants
              sentences {
                speaker_name
                text
              }
            }
          }`,
        }),
      },
      transcriptsQueryResponse,
    );

    const transcripts: NormalizedTranscript[] = res.data.transcripts.map((t) => {
      const occurredAt = typeof t.date === "number" ? new Date(t.date) : new Date(t.date);
      const text =
        t.sentences.length > 0
          ? t.sentences.map((s) => `${s.speaker_name}: ${s.text}`).join("\n")
          : t.title;

      const attendeeEmails = t.participants
        .filter((p) => p.includes("@"))
        .map((p) => p.toLowerCase().trim());

      return {
        externalId: t.id,
        title: t.title,
        occurredAt,
        text,
        language: "en",
        durationSec: t.duration ? Math.round(t.duration) : undefined,
        attendeeEmails,
      };
    });

    yield {
      kind: "transcripts",
      records: transcripts,
    };
  },
};
