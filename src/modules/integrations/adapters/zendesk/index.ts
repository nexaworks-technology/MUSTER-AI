import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AdapterContext, InboundRequest, IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import {
  ConnectionSettingMissingError,
  describeProviderError,
  OAuthClientRefusedError,
} from "../../errors";
import type { NormalizedEvent } from "../../normalized";
import { logger } from "@/lib/logger";
import {
  ProviderHttpError,
  ProviderShapeError,
  requestJson,
  type HttpTransport,
} from "../../transport";

/**
 * Zendesk adapter (spec §6B Support, M9 B6, B7).
 * Primary auth: an OAuth client (client_credentials grant, scope `read`): a token is fetched from
 * https://<subdomain>.zendesk.com/oauth/tokens once per run and sent as a Bearer header; a 401 from
 * the API refetches once and retries once. Zendesk removed API-token creation (CONNECTOR-LIVE.md, B7),
 * so the legacy path (admin email + "/token:" + API token, Basic auth) stays only for accounts that
 * still hold a token, until Zendesk switches tokens off on 30 April 2027.
 * Reads tickets incrementally via /api/v2/incremental/tickets.json?include=users (requester_id only
 * comes back on a ticket; the sideloaded users carry the email, users/show_many is the fallback) and
 * each ticket's comments via GET /api/v2/tickets/{id}/comments.json (cursor-paged). The description
 * is always the first message; internal notes (public: false) are never stored.
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
  body: z.string().nullish().default(""),
  plain_body: z.string().nullish(),
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

const zdUserSchema = z.object({
  id: z.union([z.number(), z.string()]),
  email: z.string().nullish(),
  name: z.string().nullish(),
});

/**
 * The incremental export. `end_time` is null on an empty export; `end_of_stream` says whether the
 * request returned everything up to now (the loop stops on it, never on `count`).
 */
const zdIncrementalSchema = z.object({
  tickets: z.array(zdTicketSchema).default([]),
  users: z.array(zdUserSchema).default([]),
  count: z.number().optional(),
  end_time: z.number().nullish(),
  end_of_stream: z.boolean().optional(),
  next_page: z.string().nullish(),
});

/** GET /tickets/{id}/comments.json, cursor-paged (`meta.has_more`, `meta.after_cursor`). */
const zdCommentsPageSchema = z.object({
  comments: z.array(zdCommentSchema).default([]),
  users: z.array(zdUserSchema).default([]),
  meta: z
    .object({ has_more: z.boolean().optional(), after_cursor: z.string().nullish() })
    .optional(),
});

const zdShowManySchema = z.object({ users: z.array(zdUserSchema).default([]) });

/** Admin email + "/token:" + API token. A missing email is refused, never sent empty. */
function basicAuthHeader(credentials: Credentials): string {
  const user = credentials.username;
  if (!user) throw new ConnectionSettingMissingError("Zendesk", "admin email");
  const token = credentials.apiKey ?? "";
  return `Basic ${Buffer.from(`${user}/token:${token}`).toString("base64")}`;
}

/** Read-only: GET endpoints including sideloads (Zendesk's documented `read` scope). */
export const OAUTH_SCOPE = "read";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  expires_in: z.number().optional(),
});

/** True when the connection holds an OAuth client; it wins over a legacy token. */
const usesOAuth = (c: Credentials) => !!(c.clientId || c.clientSecret);

/** Both client fields or neither; a half-filled client is refused before any request. */
function requireClient(c: Credentials): { clientId: string; clientSecret: string } {
  if (!c.clientId) throw new ConnectionSettingMissingError("Zendesk", "OAuth client ID");
  if (!c.clientSecret) throw new ConnectionSettingMissingError("Zendesk", "OAuth client secret");
  return { clientId: c.clientId, clientSecret: c.clientSecret };
}

/**
 * client_credentials grant, form-encoded, as the OAuth migration guide shows. A refusal of the
 * client (any 4xx) is OAuthClientRefusedError; a 5xx or an unreachable endpoint is left as it is,
 * so an outage is never blamed on the credentials. The secret is never logged or echoed.
 */
async function fetchAccessToken(
  transport: HttpTransport,
  subdomain: string,
  c: Credentials,
): Promise<string> {
  const { clientId, clientSecret } = requireClient(c);
  const res = await transport.request({
    method: "POST",
    url: `https://${subdomain}.zendesk.com/oauth/tokens`,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: OAUTH_SCOPE,
    }).toString(),
  });
  if (res.status >= 400 && res.status < 500) throw new OAuthClientRefusedError(res.status);
  if (res.status < 200 || res.status >= 300) throw new ProviderHttpError(res.status);
  const parsed = tokenResponseSchema.safeParse(res.body);
  if (!parsed.success) throw new ProviderShapeError("oauth token response: no access_token");
  return parsed.data.access_token;
}

/** How a run talks to Zendesk: every API read goes through `get`, which owns the credentials. */
interface ZdApi {
  origin: string;
  get<T>(url: string, schema: z.ZodType<T>): Promise<T>;
}

/**
 * OAuth: one token per run, fetched on first use; a 401 refetches once and retries once, then fails
 * honestly. Legacy token: a fixed Basic header, no retry. Missing settings throw before any request.
 */
function createApi(transport: HttpTransport, credentials: Credentials, subdomain: string): ZdApi {
  const origin = `https://${subdomain}.zendesk.com/api/v2`;
  if (!usesOAuth(credentials)) {
    const headers = { authorization: basicAuthHeader(credentials), accept: "application/json" };
    return {
      origin,
      get: (url, schema) => requestJson(transport, { method: "GET", url, headers }, schema),
    };
  }
  requireClient(credentials);
  let token: string | undefined;
  const send = async <T>(url: string, schema: z.ZodType<T>) => {
    token ??= await fetchAccessToken(transport, subdomain, credentials);
    return requestJson(
      transport,
      {
        method: "GET",
        url,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      },
      schema,
    );
  };
  return {
    origin,
    async get(url, schema) {
      try {
        return await send(url, schema);
      } catch (err) {
        if (!(err instanceof ProviderHttpError) || err.status !== 401) throw err;
        token = undefined; // expired or revoked: fetch a new one, once
        return send(url, schema);
      }
    },
  };
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

/**
 * Scale limits, stated here and in CONNECTOR-LIVE.md. Zendesk allows 10 export requests a minute, so a
 * run reads at most this many export pages (1,000 tickets each); the cursor saved is the last
 * end_time reached and the next run continues from it. Comments are read per ticket, at most this
 * many pages of 100; a ticket past the cap keeps the comments read so far and is logged.
 */
export const MAX_EXPORT_PAGES = 10;
export const MAX_COMMENT_PAGES = 20;
const COMMENT_PAGE_SIZE = 100;
const SHOW_MANY_MAX_IDS = 100;

type ZdUser = z.infer<typeof zdUserSchema>;
type ZdComment = z.infer<typeof zdCommentSchema>;
type ZdTicket = z.infer<typeof zdTicketSchema>;

const idKey = (v: number | string) => String(v);

/** Same text, ignoring whitespace differences between the description and the opening comment. */
const sameText = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/**
 * Requesters the sideload did not carry, read with GET /api/v2/users/show_many.json (up to 100 ids
 * a request). A requester still missing afterwards stays unresolved; nothing is guessed.
 */
async function resolveMissingUsers(api: ZdApi, known: Map<string, ZdUser>, wanted: string[]) {
  const missing = [...new Set(wanted)].filter((id) => !known.get(id)?.email);
  for (let i = 0; i < missing.length; i += SHOW_MANY_MAX_IDS) {
    const ids = missing.slice(i, i + SHOW_MANY_MAX_IDS);
    const url = new URL(`${api.origin}/users/show_many.json`);
    url.searchParams.set("ids", ids.join(","));
    const res = await api.get(url.toString(), zdShowManySchema);
    for (const u of res.users) known.set(idKey(u.id), u);
  }
}

/** A ticket's comments, oldest first, internal notes dropped (same rule as Freshdesk). */
async function readComments(
  api: ZdApi,
  ticketId: string,
  known: Map<string, ZdUser>,
): Promise<ZdComment[]> {
  const out: ZdComment[] = [];
  let after: string | undefined;
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const url = new URL(`${api.origin}/tickets/${encodeURIComponent(ticketId)}/comments.json`);
    url.searchParams.set("page[size]", String(COMMENT_PAGE_SIZE));
    url.searchParams.set("include", "users"); // authors' emails for the message addresses
    if (after) url.searchParams.set("page[after]", after);
    const res = await api.get(url.toString(), zdCommentsPageSchema);
    for (const u of res.users) if (u.email && !known.has(idKey(u.id))) known.set(idKey(u.id), u);
    out.push(...res.comments.filter((c) => c.public));
    if (!res.meta?.has_more || !res.meta.after_cursor) return sortByTime(out);
    after = res.meta.after_cursor;
    if (page === MAX_COMMENT_PAGES)
      logger.warn(
        { ticketId, pages: page },
        "zendesk comment page cap reached; later comments not read",
      );
  }
  return sortByTime(out);
}

const sortByTime = (cs: ZdComment[]) =>
  [...cs].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

const commentText = (c: ZdComment) => (c.plain_body ?? c.body ?? "").trim();

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

async function mapTicket(api: ZdApi, t: ZdTicket, users: Map<string, ZdUser>) {
  const ticketId = idKey(t.id);
  const requester = t.requester_id ? users.get(idKey(t.requester_id)) : undefined;
  const requesterEmail = requester?.email || undefined;
  const requesterName = requester?.name || undefined;
  const comments = await readComments(api, ticketId, users);

  const description = (t.description ?? "").trim();
  const isRequester = (c: ZdComment) =>
    t.requester_id !== undefined &&
    c.author_id !== undefined &&
    idKey(c.author_id) === idKey(t.requester_id);

  // The description is the customer's first message. The first comment is the same text under its
  // own id, so it is dropped when it matches; with no description it stays as the opening message.
  const [opening, ...rest] = comments;
  const openingIsDescription =
    !!opening &&
    !!description &&
    (sameText(commentText(opening), description) || opening.created_at === t.created_at);
  const replies = description ? (openingIsDescription ? rest : comments) : comments;

  const thread = [
    ...(description
      ? [
          {
            externalId: `${ticketId}_desc`,
            direction: "INBOUND" as const,
            fromAddress: requesterEmail,
            fromName: requesterName,
            bodyText: description,
            sentAt: new Date(t.created_at),
          },
        ]
      : []),
    ...replies
      .filter((c) => commentText(c))
      .map((c) => {
        const author = c.author_id ? users.get(idKey(c.author_id)) : undefined;
        const inbound = isRequester(c);
        return {
          externalId: idKey(c.id),
          direction: inbound ? ("INBOUND" as const) : ("OUTBOUND" as const),
          fromAddress: author?.email || (inbound ? requesterEmail : undefined),
          fromName: author?.name || (inbound ? requesterName : undefined),
          bodyText: commentText(c),
          sentAt: new Date(c.created_at),
        };
      }),
  ];

  return {
    externalId: ticketId,
    subject: t.subject,
    status: STATUS_MAP[t.status.toLowerCase()] ?? "OPEN",
    priority: PRIORITY_MAP[(t.priority ?? "normal").toLowerCase()] ?? "NORMAL",
    requesterEmail,
    requesterName,
    requesterUnresolvedReason: requesterEmail
      ? undefined
      : `Zendesk returned no email for requester ${t.requester_id ?? "(none)"}, so the ticket could not be matched to an account`,
    openedAt: new Date(t.created_at),
    updatedAt: t.updated_at ? new Date(t.updated_at) : undefined,
    messages: thread,
  };
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
      const api = createApi(transport, credentials, subdomain);
      await api.get(`${api.origin}/users/me.json`, userMeSchema);
    },
  },

  async testConnection(ctx: AdapterContext<ZendeskConfig>) {
    // Missing settings throw before the try: they are described as such, not as "unreachable".
    const subdomain = getSubdomain(ctx.credentials, ctx.config);
    const api = createApi(ctx.transport, ctx.credentials, subdomain);
    try {
      const data = await api.get(`${api.origin}/users/me.json`, userMeSchema);
      return {
        ok: true,
        message: `Connected to Zendesk as ${data.user.email ?? data.user.name ?? "admin"}`,
        externalAccountId: String(data.user.id),
      };
    } catch (err) {
      if (err instanceof OAuthClientRefusedError) {
        const d = describeOAuthRefusal();
        return { ok: false, message: `${d.plain} ${d.action}` };
      }
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
    const api = createApi(ctx.transport, ctx.credentials, subdomain);
    const origin = api.origin;

    let start = opts.cursor ?? "0";
    let saved = opts.cursor;
    for (let page = 1; page <= MAX_EXPORT_PAGES; page++) {
      const url = new URL(`${origin}/incremental/tickets.json`);
      url.searchParams.set("start_time", start);
      // The export returns requester_id only; the sideloaded users carry the email.
      url.searchParams.set("include", "users");
      const data = await api.get(url.toString(), zdIncrementalSchema);

      const users = new Map<string, ZdUser>(data.users.map((u) => [idKey(u.id), u]));
      // Deleted tickets stay in the export for a while; they are never ingested (and never OPEN).
      const live = data.tickets.filter((t) => t.status.toLowerCase() !== "deleted");
      await resolveMissingUsers(
        api,
        users,
        live.flatMap((t) => (t.requester_id ? [idKey(t.requester_id)] : [])),
      );

      const records = [];
      for (const t of live) records.push(await mapTicket(api, t, users));

      // An empty export may carry end_time null: the saved cursor then stays where it was.
      const next = data.end_time ? String(data.end_time) : undefined;
      if (next) saved = next;
      yield { kind: "tickets" as const, records, cursor: saved };

      if (data.end_of_stream !== false) return;
      if (!next || next === start) return; // no progress: never loop on the same window
      start = next;
      if (page === MAX_EXPORT_PAGES)
        logger.warn(
          { pages: page, cursor: saved },
          "zendesk export page cap reached; the next run continues from the saved cursor",
        );
    }
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

      const comments = t.comments.filter((c) => c.public).length
        ? t.comments.filter((c) => c.public)
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
    if (err instanceof OAuthClientRefusedError) return describeOAuthRefusal();
    return describeProviderError(
      err,
      "Zendesk",
      "Enter your Zendesk subdomain and the OAuth client ID and secret (Admin Center › Apps and integrations › APIs › OAuth clients).",
    );
  },
};

/** The token endpoint refused the client: say which credential is likely wrong. */
function describeOAuthRefusal() {
  return {
    plain:
      "Zendesk refused the OAuth client: it was likely revoked or deleted in Admin Center, or the client secret is wrong.",
    action:
      "Check the OAuth client in Zendesk Admin Center, then replace the saved client ID and secret.",
  };
}
