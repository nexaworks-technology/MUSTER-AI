import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AdapterContext, InboundRequest, IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { ConnectionSettingMissingError, describeProviderError } from "../../errors";
import type { NormalizedEvent, NormalizedTicket } from "../../normalized";
import { ProviderHttpError, requestJson, type HttpTransport } from "../../transport";

/**
 * Freshdesk adapter (spec §6B Support, M9 B6).
 * Basic auth with API key + ":X".
 * Reads tickets and conversations via /api/v2/tickets.
 * Webhook: Conservative reading (vendor docs do not settle native cryptographic signing).
 * Refuses unverified payloads; verifies shared secret header (X-Freshdesk-Webhook-Secret).
 */
export const freshdeskConfigSchema = z.object({
  domain: z.string().trim().min(1).optional(),
});
export type FreshdeskConfig = z.infer<typeof freshdeskConfigSchema>;

const fdConversationSchema = z.object({
  id: z.union([z.number(), z.string()]),
  body_text: z.string().default(""),
  incoming: z.boolean().default(true),
  /** A private note is internal to the support team; it is never stored as a message. */
  private: z.boolean().default(false),
  from_email: z.string().optional(),
  created_at: z.string(),
});

const fdTicketSchema = z.object({
  id: z.union([z.number(), z.string()]),
  subject: z.string().default("No subject"),
  status: z.union([z.number(), z.string()]).default(2),
  priority: z.union([z.number(), z.string()]).default(1),
  created_at: z.string().default(() => new Date().toISOString()),
  updated_at: z.string().optional(),
  description_text: z.string().optional(),
  requester: z
    .object({
      id: z.union([z.number(), z.string()]).optional(),
      email: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  conversations: z.array(fdConversationSchema).default([]),
});

const fdTicketsListSchema = z.array(fdTicketSchema);

function basicAuthHeader(credentials: Credentials): string {
  const key = credentials.apiKey ?? "";
  return `Basic ${Buffer.from(`${key}:X`).toString("base64")}`;
}

/** The account's domain (`<domain>.freshdesk.com`). Never guessed. */
function getDomain(credentials: Credentials, config?: FreshdeskConfig): string {
  const domain = credentials.site ?? config?.domain;
  if (!domain) throw new ConnectionSettingMissingError("Freshdesk", "domain");
  return domain;
}

const LIST_PAGE = 100;
/** Freshdesk pages conversations 30 at a time; a shorter page is the last one. */
const CONVERSATION_PAGE = 30;
const MAX_CONVERSATION_PAGES = 20;

const fdConversationsSchema = z.array(fdConversationSchema);

/** A ticket's public conversations, from GET /tickets/{id}/conversations (documented, paged). */
async function readConversations(
  transport: HttpTransport,
  origin: string,
  headers: Record<string, string>,
  ticketId: string | number,
) {
  const out: z.infer<typeof fdConversationSchema>[] = [];
  for (let page = 1; page <= MAX_CONVERSATION_PAGES; page++) {
    const batch = await requestJson(
      transport,
      {
        method: "GET",
        url: `${origin}/tickets/${encodeURIComponent(String(ticketId))}/conversations?page=${page}`,
        headers,
      },
      fdConversationsSchema,
    );
    out.push(...batch.filter((c) => !c.private));
    if (batch.length < CONVERSATION_PAGE) break;
  }
  return out;
}

const FD_STATUS: Record<number, "OPEN" | "PENDING" | "SOLVED" | "CLOSED"> = {
  2: "OPEN",
  3: "PENDING",
  4: "SOLVED",
  5: "CLOSED",
};

const FD_PRIORITY: Record<number, "LOW" | "NORMAL" | "HIGH" | "URGENT"> = {
  1: "LOW",
  2: "NORMAL",
  3: "HIGH",
  4: "URGENT",
};

export function verifyFreshdeskSignature(req: InboundRequest, secret: string, _now: Date): boolean {
  // Conservative reading: Freshdesk webhooks use a configured custom shared-secret header
  const headerSecret =
    req.headers["x-freshdesk-webhook-secret"] ??
    req.headers["x-freshdesk-webhook-secret".toLowerCase()] ??
    req.headers["x-webhook-secret"] ??
    req.headers["x-webhook-secret".toLowerCase()];

  if (!headerSecret) return false;

  const expectedBuf = Buffer.from(secret);
  const gotBuf = Buffer.from(headerSecret);
  if (expectedBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}

export const freshdeskAdapter: IntegrationAdapter<FreshdeskConfig> = {
  provider: "FRESHDESK",
  category: "SUPPORT",
  displayName: "Freshdesk",
  configSchema: freshdeskConfigSchema,

  auth: {
    kind: "apiKey",
    async validate(credentials, transport, config) {
      const domain = getDomain(credentials, config as FreshdeskConfig);
      await requestJson(
        transport,
        {
          method: "GET",
          url: `https://${domain}.freshdesk.com/api/v2/tickets?per_page=1`,
          headers: {
            authorization: basicAuthHeader(credentials),
            accept: "application/json",
          },
        },
        fdTicketsListSchema,
      );
    },
  },

  async testConnection(ctx: AdapterContext<FreshdeskConfig>) {
    const domain = getDomain(ctx.credentials, ctx.config);
    try {
      await requestJson(
        ctx.transport,
        {
          method: "GET",
          url: `https://${domain}.freshdesk.com/api/v2/tickets?per_page=1`,
          headers: {
            authorization: basicAuthHeader(ctx.credentials),
            accept: "application/json",
          },
        },
        fdTicketsListSchema,
      );
      return { ok: true, message: `Connected to Freshdesk (${domain}.freshdesk.com)` };
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        return { ok: false, message: `Freshdesk rejected the credentials (HTTP ${err.status})` };
      }
      return { ok: false, message: "Freshdesk could not be reached" };
    }
  },

  async *sync(
    ctx: AdapterContext<FreshdeskConfig>,
    opts: { kind: "FULL" | "INCREMENTAL"; cursor?: string },
  ) {
    const domain = getDomain(ctx.credentials, ctx.config);
    const headers = {
      authorization: basicAuthHeader(ctx.credentials),
      accept: "application/json",
    };
    const origin = `https://${domain}.freshdesk.com/api/v2`;
    const url = new URL(`${origin}/tickets`);
    // The list endpoint accepts only stats, requester and description. Conversations are not a
    // valid include here (they exist on the single ticket), so they are read per ticket below.
    url.searchParams.set("include", "requester,description");
    url.searchParams.set("per_page", String(LIST_PAGE));
    if (opts.cursor) {
      url.searchParams.set("updated_since", opts.cursor);
    }

    const tickets = await requestJson(
      ctx.transport,
      { method: "GET", url: url.toString(), headers },
      fdTicketsListSchema,
    );

    let latestUpdated = opts.cursor;
    const mapped = [];
    for (const t of tickets) {
      if (t.updated_at && (!latestUpdated || t.updated_at > latestUpdated)) {
        latestUpdated = t.updated_at;
      }
      const statusCode = typeof t.status === "number" ? t.status : Number(t.status) || 2;
      const priorityCode = typeof t.priority === "number" ? t.priority : Number(t.priority) || 2;
      const replies = await readConversations(ctx.transport, origin, headers, t.id);

      // The ticket's own description is the customer's first message; replies follow it.
      const thread = [
        ...(t.description_text
          ? [
              {
                id: `${t.id}_desc`,
                body_text: t.description_text,
                incoming: true,
                private: false,
                from_email: t.requester?.email,
                created_at: t.created_at,
              },
            ]
          : []),
        ...replies,
      ];

      mapped.push({
        externalId: String(t.id),
        subject: t.subject,
        status: FD_STATUS[statusCode] ?? "OPEN",
        priority: FD_PRIORITY[priorityCode] ?? "NORMAL",
        requesterEmail: t.requester?.email,
        requesterName: t.requester?.name,
        openedAt: new Date(t.created_at),
        updatedAt: t.updated_at ? new Date(t.updated_at) : undefined,
        messages: thread.map((c) => ({
          externalId: String(c.id),
          direction: c.incoming ? ("INBOUND" as const) : ("OUTBOUND" as const),
          fromAddress: c.from_email ?? (c.incoming ? t.requester?.email : undefined),
          bodyText: c.body_text || t.subject,
          sentAt: new Date(c.created_at),
        })),
      });
    }

    yield {
      kind: "tickets",
      records: mapped,
      cursor: latestUpdated ? new Date(latestUpdated).toISOString() : undefined,
    };
  },

  webhook: {
    verify(req: InboundRequest, secret: string, now: Date) {
      return verifyFreshdeskSignature(req, secret, now);
    },

    toEvents(payload: unknown): NormalizedEvent[] {
      // Handles both { freshdesk_webhook: { ticket_id, ... } } and direct ticket payload
      const schema = z.union([
        z.object({
          freshdesk_webhook: z.object({
            ticket_id: z.union([z.number(), z.string()]),
            ticket_subject: z.string().default("No subject"),
            ticket_status: z.string().optional(),
            ticket_priority: z.string().optional(),
            created_at: z.string().optional(),
            requester_email: z.string().optional(),
            requester_name: z.string().optional(),
            conversation: z
              .object({
                id: z.union([z.number(), z.string()]),
                body_text: z.string().default(""),
                incoming: z.boolean().default(true),
                created_at: z.string().optional(),
              })
              .optional(),
            ticket: fdTicketSchema.optional(),
          }),
        }),
        z.object({
          ticket: fdTicketSchema,
        }),
      ]);

      const parsed = schema.safeParse(payload);
      if (!parsed.success) return [];

      let externalEventId: string;
      let ticketRecord: NormalizedTicket;

      if ("freshdesk_webhook" in parsed.data) {
        const wh = parsed.data.freshdesk_webhook;
        externalEventId = String(wh.ticket_id);
        const subTicket = wh.ticket;
        if (subTicket) {
          ticketRecord = {
            externalId: String(subTicket.id),
            subject: subTicket.subject,
            status: FD_STATUS[Number(subTicket.status)] ?? "OPEN",
            priority: FD_PRIORITY[Number(subTicket.priority)] ?? "NORMAL",
            requesterEmail: subTicket.requester?.email ?? wh.requester_email,
            requesterName: subTicket.requester?.name ?? wh.requester_name,
            openedAt: new Date(subTicket.created_at),
            messages: subTicket.conversations.map((c) => ({
              externalId: String(c.id),
              direction: c.incoming ? ("INBOUND" as const) : ("OUTBOUND" as const),
              fromAddress: c.from_email ?? subTicket.requester?.email,
              fromName: undefined,
              toAddresses: [],
              bodyText: c.body_text,
              sentAt: new Date(c.created_at),
            })),
          };
        } else {
          ticketRecord = {
            externalId: String(wh.ticket_id),
            subject: wh.ticket_subject,
            status: "OPEN" as const,
            priority: "NORMAL" as const,
            requesterEmail: wh.requester_email,
            requesterName: wh.requester_name,
            openedAt: wh.created_at ? new Date(wh.created_at) : new Date(),
            messages: wh.conversation
              ? [
                  {
                    externalId: String(wh.conversation.id),
                    direction: wh.conversation.incoming
                      ? ("INBOUND" as const)
                      : ("OUTBOUND" as const),
                    fromAddress: wh.requester_email,
                    fromName: wh.requester_name,
                    toAddresses: [],
                    bodyText: wh.conversation.body_text || wh.ticket_subject,
                    sentAt: wh.conversation.created_at
                      ? new Date(wh.conversation.created_at)
                      : new Date(),
                  },
                ]
              : [],
          };
        }
      } else {
        const t = parsed.data.ticket;
        externalEventId = String(t.id);
        ticketRecord = {
          externalId: String(t.id),
          subject: t.subject,
          status: FD_STATUS[Number(t.status)] ?? "OPEN",
          priority: FD_PRIORITY[Number(t.priority)] ?? "NORMAL",
          requesterEmail: t.requester?.email,
          requesterName: t.requester?.name,
          openedAt: new Date(t.created_at),
          messages: t.conversations.map((c) => ({
            externalId: String(c.id),
            direction: c.incoming ? ("INBOUND" as const) : ("OUTBOUND" as const),
            fromAddress: c.from_email ?? t.requester?.email,
            fromName: undefined,
            toAddresses: [],
            bodyText: c.body_text,
            sentAt: new Date(c.created_at),
          })),
        };
      }

      return [
        {
          externalEventId,
          type: "ticket.created",
          batches: [
            {
              kind: "tickets",
              records: [ticketRecord],
            },
          ],
        },
      ];
    },
  },

  describeError(err: unknown) {
    return describeProviderError(err, "Freshdesk", "Enter your Freshdesk domain and API key.");
  },
};
