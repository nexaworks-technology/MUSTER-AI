import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { businessClock, type Clock } from "@/lib/dates";
import {
  findIntegrationByUsageKeyHash,
  findIntegrationForWebhook,
  type InboundIntegration,
} from "@/lib/db/inbound";
import { getQueue } from "@/lib/jobs/queues";
import { logger } from "@/lib/logger";
import { hitRateLimit, type RateLimit, type RateLimitResult } from "@/lib/rate-limit";
import { openCredentials } from "../credentials";
import { USAGE_AGGREGATE_JOB_OPTIONS } from "./job";
import { hashIngestKey, INGEST_KEY_PREFIX } from "./keys";
import { batchBody, toUsageEvent, type Rejected, type UsageEvent } from "./schemas";

/**
 * Usage API intake (M6 B1, M6 §2):
 *
 *   POST /api/usage/v1/track | identify | batch
 *     → authenticate (the integration's ingest key, or Segment's signature with that
 *       integration's own shared secret) → rate-limit per integration → validate every event
 *       on its own → enqueue ONE `usage.aggregate` job carrying the accepted events.
 *
 * The queue job payload is the only place raw events exist (D-23, Q-33); the aggregation job
 * folds them into the daily tables and discards them. Anything unauthenticated gets the same
 * 401 and is logged without its body. A key for one workspace can only ever name that
 * workspace: the workspace comes from the key's integration row, never from the request.
 */
export const USAGE_RATE_LIMIT: RateLimit = { limit: 600, windowSeconds: 60 };
const MAX_BODY = 1_000_000;
/** Events older than this, or more than a day ahead of the business clock, are refused. */
const MAX_AGE_DAYS = 35;
const MAX_AHEAD_MS = 86_400_000;

export interface UsageRequest {
  headers: Record<string, string>;
  rawBody: string;
  url: string;
}

export interface AggregatePayload {
  workspaceId: string;
  integrationId: string;
  batchKey: string;
  events: UsageEvent[];
}

export interface UsageDeps {
  /** The business clock: it decides "today" for events without a timestamp (D-50, D-81). */
  clock?: Clock;
  /** Wall-clock time for the rate-limit window. */
  now?: () => Date;
  limit?: RateLimit;
  hit?: (key: string, limit: RateLimit, now: Date) => Promise<RateLimitResult>;
  enqueue?: (payload: AggregatePayload) => Promise<unknown>;
}

export interface UsageResponse {
  status: 200 | 202 | 400 | 401 | 413 | 429 | 503;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

const UNVERIFIED: UsageResponse = { status: 401, body: { error: "unverified" } };

const defaultEnqueue = (p: AggregatePayload) =>
  getQueue("sync").add("usage.aggregate", p, {
    jobId: `usage-${p.integrationId}-${p.batchKey.slice(0, 40)}`,
    ...USAGE_AGGREGATE_JOB_OPTIONS,
  });

function refuse(reason: string): UsageResponse {
  logger.warn({ reason }, "usage request refused");
  return UNVERIFIED;
}

function presentedKey(headers: Record<string, string>): string | null {
  const a = headers["authorization"];
  if (!a) return null;
  const bearer = /^Bearer\s+(\S+)$/i.exec(a);
  if (bearer) return bearer[1]!;
  const basic = /^Basic\s+(\S+)$/i.exec(a);
  if (basic) {
    // Segment-style: the key is the user name, the password is empty.
    const user = Buffer.from(basic[1]!, "base64").toString("utf8").split(":")[0];
    return user || null;
  }
  return null;
}

/** HMAC-SHA1 over the raw body, hex, in `x-signature` (Segment's webhook destination). */
export function verifySegmentSignature(
  rawBody: string,
  header: string | undefined,
  secret: string,
) {
  if (!header) return false;
  const want = Buffer.from(createHmac("sha1", secret).update(rawBody).digest("hex"));
  const got = Buffer.from(header.trim().toLowerCase());
  return got.length === want.length && timingSafeEqual(got, want);
}

async function authenticate(req: UsageRequest): Promise<InboundIntegration | null> {
  const key = presentedKey(req.headers);
  if (key) {
    if (!key.startsWith(INGEST_KEY_PREFIX) || key.length > 200) return null;
    return findIntegrationByUsageKeyHash(hashIngestKey(key));
  }
  if (req.headers["x-signature"]) {
    let integrationId: string | null = null;
    try {
      integrationId = new URL(req.url, "http://local").searchParams.get("integration");
    } catch {
      return null;
    }
    if (!integrationId) return null;
    const row = await findIntegrationForWebhook(integrationId);
    if (!row || row.provider !== "USAGE_API" || row.status === "DISCONNECTED") return null;
    const secret = openCredentials(row.credentialsEnc).webhookSecret;
    if (!secret || !verifySegmentSignature(req.rawBody, req.headers["x-signature"], secret))
      return null;
    return row;
  }
  return null;
}

const eventKey = (e: UsageEvent) =>
  e.messageId
    ? `m:${e.messageId}`
    : JSON.stringify([e.kind, e.userId, e.groupRef, e.at, e.event, e.feature, e.email]);

/** Order-insensitive: the same events in any order are the same batch. */
export const batchKeyOf = (events: UsageEvent[]) =>
  createHash("sha256").update(events.map(eventKey).sort().join("\n")).digest("hex");

export async function receiveUsage(
  kind: "track" | "identify" | "batch",
  req: UsageRequest,
  deps: UsageDeps = {},
): Promise<UsageResponse> {
  if (req.rawBody.length > MAX_BODY) return { status: 413, body: { error: "too large" } };
  const integration = await authenticate(req);
  if (!integration) return refuse("not authenticated");

  const limit = deps.limit ?? USAGE_RATE_LIMIT;
  let gate: RateLimitResult;
  try {
    gate = await (deps.hit ?? hitRateLimit)(
      `usage:${integration.id}`,
      limit,
      (deps.now ?? (() => new Date()))(),
    );
  } catch {
    return { status: 503, body: { error: "try again shortly" }, headers: { "retry-after": "5" } };
  }
  if (!gate.allowed)
    return {
      status: 429,
      body: { error: "rate limit reached", limit: gate.limit },
      headers: { "retry-after": String(gate.retryAfterSeconds) },
    };

  let body: unknown;
  try {
    body = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, body: { error: "the body is not JSON" } };
  }
  let items: unknown[];
  let forced: "track" | "identify" | undefined;
  if (kind === "batch") {
    const b = batchBody.safeParse(body);
    // Segment's webhook destination posts one typed event per request, to the same endpoint.
    items = b.success ? b.data.batch : [body];
  } else {
    items = [body];
    forced = kind;
  }

  const clock = deps.clock ?? businessClock;
  const now = clock();
  const events: UsageEvent[] = [];
  const rejected: Rejected[] = [];
  let ignored = 0;
  items.forEach((raw, index) => {
    const e = toUsageEvent(raw, forced, now);
    if (e === "ignored") ignored++;
    else if (typeof e === "string") rejected.push({ index, reason: e });
    else {
      const age = now.getTime() - new Date(e.at).getTime();
      if (age > MAX_AGE_DAYS * 86_400_000)
        rejected.push({ index, reason: `timestamp: older than ${MAX_AGE_DAYS} days` });
      else if (-age > MAX_AHEAD_MS)
        rejected.push({ index, reason: "timestamp: more than a day in the future" });
      else events.push(e);
    }
  });
  if (events.length === 0 && ignored === 0)
    return { status: 400, body: { error: "no usable events", rejected: rejected.slice(0, 20) } };
  if (events.length > 0)
    await (deps.enqueue ?? defaultEnqueue)({
      workspaceId: integration.workspaceId,
      integrationId: integration.id,
      batchKey: batchKeyOf(events),
      events,
    });
  return {
    status: 202,
    body: {
      accepted: events.length,
      ignored,
      rejected: rejected.slice(0, 20),
    },
  };
}
