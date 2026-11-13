import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AdapterContext, InboundRequest, IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { ConnectionSettingMissingError, describeProviderError } from "../../errors";
import type { NormalizedEvent } from "../../normalized";
import { ProviderHttpError, requestJson } from "../../transport";

/**
 * Zendesk adapter (spec §6B Support, M9 B6).
 * Basic auth with admin email + "/token:" + API token.
 * Reads tickets and comments incrementally via /api/v2/incremental/tickets.json.
 * Webhooks: HMAC-SHA256 signature verification with 5-minute tolerance.
 */
const TOLERANCE_SECONDS = 300;

export const zendeskConfigSchema = z.object({
  subdomain: z.string().trim().min(1).optional(),
});
export type ZendeskConfig = z.infer<typeof zendeskConfigSchema>;

const userMeSchema = z.object({
  user: z.object({
    id: z.union([z.number(), z.string()]),
    name: z.string().optional(),
    email: z.string().optional(),
  }),
});

const zdCommentSchema = z.object({
  id: z.union([z.number(), z.string()]),
  body: z.string().default(""),
  author_id: z.union([z.number(), z.string()]).optional(),
  author_email: z.string().optional(),
  public: z.boolean().default(true),
  created_at: z.string(),
});

const zdTicketSchema = z.object({
  id: z.union([z.number(), z.string()]),
  subject: z.string().default("No subject"),
  status: z.string().default("open"),
  priority: z.string().nullable().optional(),
  requester_id: z.union([z.number(), z.string()]).optional(),
  requester: z
    .object({
      id: z.union([z.number(), z.string()]).optional(),
      email: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  description: z.string().optional(),
  comments: z.array(zdCommentSchema).default([]),
});

const zdIncrementalSchema = z.object({
  tickets: z.array(zdTicketSchema).default([]),
  users: z
    .array(
      z.object({
        id: z.union([z.number(), z.string()]),
        email: z.string().optional(),
        name: z.string().optional(),
      }),
    )
    .default([]),
  count: z.number().default(0),
  end_time: z.number().optional(),
  next_page: z.string().optional(),
});

/** Admin email + "/token:" + API token. A missing email is refused, never sent empty. */
function basicAuthHeader(credentials: Credentials): string {
  const user = credentials.username;
  if (!user) throw new ConnectionSettingMissingError("Zendesk", "admin email");
  const token = credentials.apiKey ?? "";
  return `Basic ${Buffer.from(`${user}/token:${token}`).toString("base64")}`;
}

/** The account's subdomain (`<subdomain>.zendesk.com`). Never guessed. */
function getSubdomain(credentials: Credentials, config?: ZendeskConfig): string {
  const subdomain = credentials.site ?? config?.subdomain;
  if (!subdomain) throw new ConnectionSettingMissingError("Zendesk", "subdomain");
  return subdomain;
}

const STATUS_MAP: Record<string, "OPEN" | "PENDING" | "SOLVED" | "CLOSED"> = {
  new: "OPEN",
  open: "OPEN",
  pending: "PENDING",
  hold: "PENDING",
  solved: "SOLVED",
  closed: "CLOSED",
};

const PRIORITY_MAP: Record<string, "LOW" | "NORMAL" | "HIGH" | "URGENT"> = {
  low: "LOW",
  normal: "NORMAL",
  high: "HIGH",
  urgent: "URGENT",
};

export function verifyZendeskSignature(req: InboundRequest, secret: string, now: Date): boolean {
  const sigHeader =
    req.headers["x-zendesk-webhook-signature"] ??
    req.headers["x-zendesk-webhook-signature".toLowerCase()];
  const tsHeader =
    req.headers["x-zendesk-webhook-signature-timestamp"] ??
    req.headers["x-zendesk-webhook-signature-timestamp".toLowerCase()];

  if (!sigHeader || !tsHeader) return false;

  const timestampNum = Number(tsHeader);
  if (!Number.isFinite(timestampNum)) return false;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestampNum) > TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret)
    .update(`${tsHeader}${req.rawBody}`)
    .digest("base64");

  const expectedBuf = Buffer.from(expected);
  const gotBuf = Buffer.from(sigHeader);
  if (expectedBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}

export const zendeskAdapter: IntegrationAdapter<ZendeskConfig> = {
  provider: "ZENDESK",
  category: "SUPPORT",
  displayName: "Zendesk",
  configSchema: zendeskConfigSchema,

  auth: {
    kind: "apiKey",
    async validate(credentials, transport, config) {
      const subdomain = getSubdomain(credentials, config as ZendeskConfig);
      await requestJson(
        transport,
        {
          method: "GET",
          url: `https://${subdomain}.zendesk.com/api/v2/users/me.json`,
          headers: {
            authorization: basicAuthHeader(credentials),
            accept: "application/json",
          },
        },
        userMeSchema,
      );
    },
  },

  async testConnection(ctx: AdapterContext<ZendeskConfig>) {
    // Missing settings throw before the try: they are described as such, not as "unreachable".
    const subdomain = getSubdomain(ctx.credentials, ctx.config);
    const authorization = basicAuthHeader(ctx.credentials);
    try {
      const data = await requestJson(
        ctx.transport,
        {
          method: "GET",
          url: `https://${subdomain}.zendesk.com/api/v2/users/me.json`,
          headers: { authorization, accept: "application/json" },
        },
        userMeSchema,
      );
      return {
        ok: true,
        message: `Connected to Zendesk as ${data.user.email ?? data.user.name ?? "admin"}`,
        externalAccountId: String(data.user.id),
      };
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        return { ok: false, message: `Zendesk rejected the credentials (HTTP ${err.status})` };
      }
      return { ok: false, message: "Zendesk could not be reached" };
    }
  },

  async *sync(
    ctx: AdapterContext<ZendeskConfig>,
    opts: { kind: "FULL" | "INCREMENTAL"; cursor?: string },
  ) {
    const subdomain = getSubdomain(ctx.credentials, ctx.config);
    const authorization = basicAuthHeader(ctx.credentials);
    const startTime = opts.cursor ?? "0";
    const url = new URL(`https://${subdomain}.zendesk.com/api/v2/incremental/tickets.json`);
    url.searchParams.set("start_time", startTime);

    const data = await requestJson(
      ctx.transport,
      {
        method: "GET",
        url: url.toString(),
        headers: { authorization, accept: "application/json" },
      },
      zdIncrementalSchema,
    );

    const userMap = new Map(data.users.map((u) => [String(u.id), u]));

    const mappedTickets = data.tickets.map((t) => {
      const reqUser = t.requester_id ? userMap.get(String(t.requester_id)) : t.requester;
      const requesterEmail = reqUser?.email ?? t.requester?.email;
      const requesterName = reqUser?.name ?? t.requester?.name;

      const comments = t.comments.length
        ? t.comments
        : t.description
          ? [
              {
                id: `${t.id}_desc`,
                body: t.description,
                author_id: t.requester_id,
                public: true,
                created_at: t.created_at,
              },
            ]
          : [];

      return {
        externalId: String(t.id),
        subject: t.subject,
        status: STATUS_MAP[t.status.toLowerCase()] ?? "OPEN",
        priority: PRIORITY_MAP[(t.priority ?? "normal").toLowerCase()] ?? "NORMAL",
        requesterEmail,
        requesterName,
        openedAt: new Date(t.created_at),
        updatedAt: t.updated_at ? new Date(t.updated_at) : undefined,
        messages: comments.map((c) => {
          const authorUser = c.author_id ? userMap.get(String(c.author_id)) : undefined;
          const authorEmail = c.author_email ?? authorUser?.email;
          const isRequester =
            (c.author_id && t.requester_id && String(c.author_id) === String(t.requester_id)) ||
            (authorEmail &&
              requesterEmail &&
              authorEmail.toLowerCase() === requesterEmail.toLowerCase());
          return {
            externalId: String(c.id),
            direction: isRequester ? ("INBOUND" as const) : ("OUTBOUND" as const),
            fromAddress: authorEmail ?? (isRequester ? requesterEmail : undefined),
            fromName: authorUser?.name ?? (isRequester ? requesterName : undefined),
            bodyText: c.body || t.subject,
            sentAt: new Date(c.created_at),
          };
        }),
      };
    });

    const nextCursor = data.end_time ? String(data.end_time) : undefined;
    yield {
      kind: "tickets",
      records: mappedTickets,
      cursor: nextCursor,
    };
  },

  webhook: {
    verify(req: InboundRequest, secret: string, now: Date) {
      return verifyZendeskSignature(req, secret, now);
    },

    toEvents(payload: unknown): NormalizedEvent[] {
      const schema = z.object({
        id: z.string().optional(),
        event_type: z.string().default("ticket.updated"),
        ticket: zdTicketSchema,
      });

      const parsed = schema.safeParse(payload);
      if (!parsed.success) return [];

      const raw = parsed.data;
      const t = raw.ticket;
      const externalEventId = raw.id ?? `zd_evt_${t.id}_${Date.now()}`;

      const comments = t.comments.length
        ? t.comments
        : t.description
          ? [
              {
                id: `${t.id}_desc`,
                body: t.description,
                author_email: t.requester?.email,
                public: true,
                created_at: t.created_at,
              },
            ]
          : [];

      const normalizedTicketRecord = {
        externalId: String(t.id),
        subject: t.subject,
        status: STATUS_MAP[t.status.toLowerCase()] ?? "OPEN",
        priority: PRIORITY_MAP[(t.priority ?? "normal").toLowerCase()] ?? "NORMAL",
        requesterEmail: t.requester?.email,
        requesterName: t.requester?.name,
        openedAt: new Date(t.created_at),
        messages: comments.map((c) => ({
          externalId: String(c.id),
          direction: "INBOUND" as const,
          fromAddress: c.author_email ?? t.requester?.email,
          bodyText: c.body || t.subject,
          sentAt: new Date(c.created_at),
        })),
      };

      return [
        {
          externalEventId,
          type: raw.event_type,
          batches: [
            {
              kind: "tickets",
              records: [normalizedTicketRecord],
            },
          ],
        },
      ];
    },
  },

  describeError(err: unknown) {
    return describeProviderError(
      err,
      "Zendesk",
      "Enter your Zendesk subdomain, admin email and API token.",
    );
  },
};
