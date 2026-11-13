import { z } from "zod";
import { env } from "@/lib/config/env";
import type { AdapterContext, IntegrationAdapter } from "../../adapter";
import type { Credentials } from "../../credentials";
import { describeProviderError } from "../../errors";
import type { NormalizedBatch, NormalizedMail } from "../../normalized";
import {
  ProviderHttpError,
  ProviderShapeError,
  requestJson,
  type HttpTransport,
} from "../../transport";

const API = "https://gmail.googleapis.com";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

export const googleEmailConfig = z.record(z.string(), z.unknown()).default({});
type Cfg = z.infer<typeof googleEmailConfig>;

const tokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
});

const profileSchema = z.object({
  emailAddress: z.string().email(),
  messagesTotal: z.number().int().optional(),
  threadsTotal: z.number().int().optional(),
  historyId: z.string().optional(),
});

const messageListSchema = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string() })).default([]),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});

const messageHeader = z.object({
  name: z.string(),
  value: z.string(),
});

const messageDetailSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).default([]),
  snippet: z.string().default(""),
  internalDate: z.string(),
  payload: z
    .object({
      headers: z.array(messageHeader).default([]),
      body: z.object({ data: z.string().optional(), size: z.number().optional() }).optional(),
      parts: z
        .array(
          z.object({
            mimeType: z.string().optional(),
            body: z.object({ data: z.string().optional() }).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

function auth(c: Credentials): Record<string, string> {
  if (!c.accessToken) throw new Error("Gmail has no access token");
  return { authorization: `Bearer ${c.accessToken}` };
}

function clientCredentials() {
  const e = env();
  if (!e.GOOGLE_EMAIL_CLIENT_ID || !e.GOOGLE_EMAIL_CLIENT_SECRET) {
    if (e.INTEGRATIONS_TRANSPORT === "fixture" || e.NODE_ENV === "test")
      return { client_id: "fixture-client", client_secret: "fixture-client-secret" };
    throw new Error("GOOGLE_EMAIL_CLIENT_ID and GOOGLE_EMAIL_CLIENT_SECRET are not set");
  }
  return { client_id: e.GOOGLE_EMAIL_CLIENT_ID, client_secret: e.GOOGLE_EMAIL_CLIENT_SECRET };
}

function parseEmail(raw: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(raw) ?? /([^\s<>"]+@[^\s<>"]+)/.exec(raw);
  return m ? m[1]!.toLowerCase() : raw.trim().toLowerCase();
}

function parseName(raw: string): string | undefined {
  const m = /^"?([^"<]+)"?\s*</.exec(raw.trim());
  return m ? m[1]!.trim() : undefined;
}

function parseRecipients(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => parseEmail(s))
    .filter((s) => s.includes("@"));
}

function decodeBody(detail: z.infer<typeof messageDetailSchema>): string {
  const data =
    detail.payload?.body?.data ??
    detail.payload?.parts?.find((p) => p.mimeType === "text/plain")?.body?.data;
  if (data) {
    try {
      return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    } catch {
      // Fallback to snippet below
    }
  }
  return detail.snippet || "No body content";
}

type MessageStub = { id: string; threadId: string };
type HistoryPage = { stubs: MessageStub[]; historyId?: string };

const PAGE_SIZE = "100";

const historySchema = z.object({
  history: z
    .array(
      z.object({
        id: z.string(),
        messagesAdded: z
          .array(z.object({ message: z.object({ id: z.string(), threadId: z.string() }) }))
          .default([]),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
  historyId: z.string().optional(),
});

/** Refuses a page token Gmail already gave in this run, instead of looping forever. */
function nextToken(seen: Set<string>, token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  if (seen.has(token)) throw new ProviderShapeError("Gmail repeated a page token");
  seen.add(token);
  return token;
}

/** Every message id in the mailbox, newest first, one page (up to 100) at a time. */
async function* listPages(t: HttpTransport, c: Credentials): AsyncGenerator<MessageStub[]> {
  const seen = new Set<string>();
  let pageToken: string | undefined;
  do {
    const url = new URL(`${API}/gmail/v1/users/me/messages`);
    url.searchParams.set("maxResults", PAGE_SIZE);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await requestJson(
      t,
      { method: "GET", url: url.toString(), headers: auth(c) },
      messageListSchema,
    );
    yield page.messages;
    pageToken = nextToken(seen, page.nextPageToken);
  } while (pageToken);
}

/** Messages added since `startHistoryId`, page by page, each with the historyId Gmail reported. */
async function* historyPages(
  t: HttpTransport,
  c: Credentials,
  startHistoryId: string,
): AsyncGenerator<HistoryPage> {
  const seen = new Set<string>();
  const seenIds = new Set<string>();
  let pageToken: string | undefined;
  do {
    const url = new URL(`${API}/gmail/v1/users/me/history`);
    url.searchParams.set("startHistoryId", startHistoryId);
    url.searchParams.set("historyTypes", "messageAdded");
    url.searchParams.set("maxResults", PAGE_SIZE);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await requestJson(
      t,
      { method: "GET", url: url.toString(), headers: auth(c) },
      historySchema,
    );
    const stubs: MessageStub[] = [];
    for (const h of page.history)
      for (const added of h.messagesAdded)
        if (!seenIds.has(added.message.id)) {
          seenIds.add(added.message.id);
          stubs.push(added.message);
        }
    yield { stubs, historyId: page.historyId };
    pageToken = nextToken(seen, page.nextPageToken);
  } while (pageToken);
}

/**
 * The history pages as message stubs; the newest historyId Gmail reports becomes the run's
 * cursor as each page is consumed (sync.jobs keeps it only when the whole run succeeds).
 */
async function* withHistoryCursor(
  first: IteratorResult<HistoryPage>,
  rest: AsyncGenerator<HistoryPage>,
  setCursor: (historyId: string) => void,
): AsyncGenerator<MessageStub[]> {
  if (first.done) return;
  for (let page: HistoryPage | undefined = first.value; page;) {
    if (page.historyId) setCursor(page.historyId);
    yield page.stubs;
    const next = await rest.next();
    page = next.done ? undefined : next.value;
  }
}

/** One message as normalized mail, or null when it has no sender or recipient. */
async function readMessage(
  t: HttpTransport,
  c: Credentials,
  id: string,
  mailbox: string,
): Promise<NormalizedMail | null> {
  const detail = await requestJson(
    t,
    { method: "GET", url: `${API}/gmail/v1/users/me/messages/${id}`, headers: auth(c) },
    messageDetailSchema,
  );
  const headers = detail.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const fromRaw = getHeader("From");
  const fromAddress = parseEmail(fromRaw);
  const toAddresses = parseRecipients(getHeader("To"));
  if (!fromAddress || toAddresses.length === 0) return null;
  const isOutbound =
    detail.labelIds.includes("SENT") || fromAddress.toLowerCase() === mailbox.toLowerCase();
  // An unparseable Date header falls back to Gmail's own receipt time, never to "now".
  const dateRaw = getHeader("Date");
  const fromHeader = dateRaw ? new Date(dateRaw) : null;
  const sentAt =
    fromHeader && !isNaN(fromHeader.getTime()) ? fromHeader : new Date(Number(detail.internalDate));
  return {
    externalId: detail.id,
    threadExternalId: detail.threadId,
    direction: isOutbound ? "OUTBOUND" : "INBOUND",
    fromAddress,
    fromName: parseName(fromRaw),
    toAddresses,
    subject: getHeader("Subject"),
    bodyText: decodeBody(detail),
    sentAt,
  };
}

export const googleEmailAdapter: IntegrationAdapter<Cfg> = {
  provider: "GOOGLE_EMAIL",
  category: "EMAIL",
  displayName: "Gmail",
  configSchema: googleEmailConfig,
  auth: {
    kind: "oauth2",
    scopes: GMAIL_SCOPES,
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(AUTH);
      url.searchParams.set("client_id", clientCredentials().client_id);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", GMAIL_SCOPES.join(" "));
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
      if (!c.refreshToken) throw new Error("Gmail has no refresh token");
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
    const profile = await requestJson(
      ctx.transport,
      {
        method: "GET",
        url: `${API}/gmail/v1/users/me/profile`,
        headers: auth(ctx.credentials),
      },
      profileSchema,
    );
    return {
      ok: true,
      message: `Connected to Gmail (${profile.emailAddress}). Read-only.`,
      externalAccountId: profile.emailAddress,
    };
  },
  async *sync(ctx, opts): AsyncGenerator<NormalizedBatch> {
    const { transport: t, credentials: c } = ctx;
    // Read first: anything that arrives while this run pages is picked up by the next one.
    const profile = await requestJson(
      t,
      { method: "GET", url: `${API}/gmail/v1/users/me/profile`, headers: auth(c) },
      profileSchema,
    );

    let cursor = profile.historyId;
    let pages: AsyncIterable<MessageStub[]> = listPages(t, c);
    if (opts.kind === "INCREMENTAL" && opts.cursor) {
      const changed = historyPages(t, c, opts.cursor);
      let first: IteratorResult<HistoryPage> | null;
      try {
        first = await changed.next();
      } catch (err) {
        // Gmail keeps history for a limited time; an expired start id is a 404: read it all again.
        if (!(err instanceof ProviderHttpError && err.status === 404)) throw err;
        first = null;
      }
      if (first) pages = withHistoryCursor(first, changed, (id) => (cursor = id));
    }

    for await (const stubs of pages) {
      const records: NormalizedMail[] = [];
      for (const stub of stubs) {
        const mail = await readMessage(t, c, stub.id, profile.emailAddress);
        if (mail) records.push(mail);
      }
      yield { kind: "mail", records };
    }

    // No cursor is made up: without a historyId the next run reads again from the start.
    if (cursor) yield { kind: "mail", records: [], cursor };
  },
  writeBack: {
    fields: [{ key: "draft", label: "Draft in mailbox" }],
    async push(ctx, change) {
      if (change.field !== "draft") throw new Error("Gmail writes only drafts");
      const created = await requestJson(
        ctx.transport,
        {
          method: "POST",
          url: `${API}/gmail/v1/users/me/drafts`,
          headers: { ...auth(ctx.credentials), "content-type": "application/json" },
          body: JSON.stringify({
            message: {
              threadId: change.externalId,
              raw: Buffer.from(`Subject: Draft\r\n\r\n${change.value}`).toString("base64url"),
            },
          }),
        },
        z.object({ id: z.string() }),
      );
      return { externalId: created.id };
    },
  },
  describeError: (err) =>
    describeProviderError(err, "Gmail", "Reconnect Gmail from Settings › Integrations."),
};
