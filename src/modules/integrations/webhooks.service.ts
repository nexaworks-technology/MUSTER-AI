import { createHash } from "node:crypto";
import { Prisma, type IntegrationProvider } from "@prisma/client";
import { z } from "zod";
import { businessClock, realClock, todayIn, type Clock } from "@/lib/dates";
import { findIntegrationForWebhook } from "@/lib/db/inbound";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { getQueue } from "@/lib/jobs/queues";
import { logger } from "@/lib/logger";
import { getStorage } from "@/lib/storage";
import { loadContext } from "@/modules/health/service";
import { enqueueAccountEvaluation, evaluateAndStore } from "@/modules/signals/service";
import type { InboundRequest, IntegrationAdapter } from "./adapter";
import { adapterFor } from "./adapters";
import { openCredentials } from "./credentials";
import { ingestBatch } from "./ingest.service";
import { recordSourceFor } from "./providers";
import { notifySignalsOpened, type SlackDeps } from "./slack/service";

/**
 * Webhook intake (M5 §2, rule 4: webhooks are untrusted input).
 *
 *   POST /api/integrations/<provider>/webhook/<integrationId>
 *     → look up exactly that integration (inbound RLS policy) → verify the signature with THAT
 *       integration's own secret (D3) → store the raw payload → insert WebhookEvent, unique per
 *       (workspace, integration, externalEventId) → enqueue `webhook.process`.
 *
 * Anything unverified (unknown integration, wrong provider, no secret, bad signature, stale
 * timestamp) gets the same 401, is logged without its body, and stores nothing. A replay of a
 * verified event is a no-op. Processing ingests the event's records through the one ingest path
 * and evaluates the affected account's signals inside the same job (ARCHITECTURE §5.2).
 */
export interface WebhookDeps extends Pick<SlackDeps, "delivery" | "transport"> {
  clock?: Clock;
  adapter?: (provider: IntegrationProvider) => IntegrationAdapter<unknown>;
  storage?: Pick<ReturnType<typeof getStorage>, "put" | "get" | "ensureBucket">;
  enqueue?: (webhookEventId: string, workspaceId: string) => Promise<unknown>;
}

export interface WebhookResponse {
  status: 200 | 202 | 400 | 401;
  body: string;
}

const UNVERIFIED: WebhookResponse = { status: 401, body: "unverified" };

/** Storage key segment for an event id (provider ids may contain characters keys refuse). */
const eventKey = (externalEventId: string) =>
  createHash("sha256").update(externalEventId).digest("hex").slice(0, 40);

const defaultEnqueue = (webhookEventId: string, workspaceId: string) =>
  getQueue("sync").add(
    "webhook.process",
    { workspaceId, webhookEventId },
    {
      jobId: `webhook-${webhookEventId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
    },
  );

function refuse(provider: IntegrationProvider, integrationId: string, reason: string) {
  logger.warn({ provider, integrationId, reason }, "webhook refused");
  return UNVERIFIED;
}

export async function receiveWebhook(
  provider: IntegrationProvider,
  integrationId: string,
  req: InboundRequest,
  deps: WebhookDeps = {},
): Promise<WebhookResponse> {
  const integration = await findIntegrationForWebhook(integrationId);
  if (!integration || integration.provider !== provider || integration.status === "DISCONNECTED")
    return refuse(provider, integrationId, "no such connected integration");
  let adapter: IntegrationAdapter<unknown>;
  try {
    adapter = (deps.adapter ?? adapterFor)(provider);
  } catch {
    return refuse(provider, integrationId, "no adapter");
  }
  const secret = openCredentials(integration.credentialsEnc).webhookSecret;
  if (!adapter.webhook || !secret) return refuse(provider, integrationId, "no webhook secret");
  if (!adapter.webhook.verify(req, secret, (deps.clock ?? realClock)()))
    return refuse(provider, integrationId, "signature did not verify");

  // Verified from here on; the body is still parsed defensively.
  let payload: unknown;
  try {
    payload = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, body: "not json" };
  }
  const events = adapter.webhook.toEvents(payload);
  if (events.length === 0) return { status: 200, body: "ignored" };
  const ctx: TenantContext = { workspaceId: integration.workspaceId };
  const storage = deps.storage ?? getStorage();
  await storage.ensureBucket();
  let accepted = 0;
  for (const event of events) {
    const segments = ["webhooks", integration.id, `${eventKey(event.externalEventId)}.json`];
    const { key } = await storage.put(ctx, segments, req.rawBody, "application/json");
    try {
      const row = await scopedDb(ctx).webhookEvent.create({
        data: {
          workspaceId: ctx.workspaceId,
          integrationId: integration.id,
          externalEventId: event.externalEventId,
          eventType: event.type,
          payloadStorageKey: key,
        },
      });
      await (deps.enqueue ?? defaultEnqueue)(row.id, ctx.workspaceId);
      accepted++;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue; // replay
      throw e;
    }
  }
  return accepted ? { status: 202, body: "accepted" } : { status: 200, body: "duplicate" };
}

export const webhookProcessPayload = z.object({
  workspaceId: z.string().min(1),
  webhookEventId: z.string().min(1),
});

export interface WebhookProcessResult {
  status: "PROCESSED" | "IGNORED" | "SKIPPED";
  accountIds: string[];
  signalsOpened: number;
}

/** The `webhook.process` worker job. Idempotent: a processed event is skipped. */
export async function processWebhookEvent(
  raw: unknown,
  deps: WebhookDeps = {},
): Promise<WebhookProcessResult> {
  const { workspaceId, webhookEventId } = webhookProcessPayload.parse(raw);
  const ctx = { workspaceId };
  const db = scopedDb(ctx);
  const event = await db.webhookEvent.findUnique({
    where: { id: webhookEventId },
    include: { integration: { select: { id: true, provider: true, status: true } } },
  });
  if (!event || event.status === "PROCESSED" || event.status === "IGNORED")
    return { status: "SKIPPED", accountIds: [], signalsOpened: 0 };
  const source = recordSourceFor(event.integration.provider);
  const adapter = (deps.adapter ?? adapterFor)(event.integration.provider);
  try {
    const prefix = `ws/${workspaceId}/`;
    if (!event.payloadStorageKey.startsWith(prefix)) throw new Error("payload outside workspace");
    const bytes = await (deps.storage ?? getStorage()).get(
      ctx,
      event.payloadStorageKey.slice(prefix.length).split("/"),
    );
    const normalized = adapter.webhook
      ?.toEvents(JSON.parse(Buffer.from(bytes).toString("utf8")))
      .find((e) => e.externalEventId === event.externalEventId);
    const accountIds = new Set<string>();
    if (normalized && source) {
      for (const batch of normalized.batches) {
        const r = await ingestBatch(
          { workspaceId, integrationId: event.integration.id, source },
          batch,
        );
        r.accountIds.forEach((id) => accountIds.add(id));
      }
      if (normalized.realtimeCustomerExternalId) {
        const ref = await db.externalRef.findFirst({
          where: {
            source,
            objectType: "Customer",
            externalId: normalized.realtimeCustomerExternalId,
          },
          select: { internalId: true },
        });
        if (ref) accountIds.add(ref.internalId);
      }
    }
    // Real time for big signals (§5.2): evaluate these accounts' rules inside this job, then
    // queue the usual evaluate+score chunk so health catches up the same way as nightly.
    let opened = 0;
    if (accountIds.size && normalized?.realtimeCustomerExternalId) {
      const clock = deps.clock ?? businessClock;
      const asOf = todayIn((await loadContext(ctx)).timeZone, clock);
      const since = realClock();
      opened = (await evaluateAndStore(ctx, [...accountIds], asOf, clock)).opened;
      await enqueueAccountEvaluation(ctx, [...accountIds], `webhook-${event.eventType}`, clock);
      if (opened) {
        // Big signals reach the account owner in Slack right away (no-op without Slack; D-95).
        const fresh = await db.signal.findMany({
          where: { accountId: { in: [...accountIds] }, status: "OPEN", createdAt: { gte: since } },
          select: { id: true },
        });
        await notifySignalsOpened(
          ctx,
          fresh.map((f) => f.id),
          deps,
        ).catch((err: unknown) =>
          logger.warn(
            { workspaceId, err: err instanceof Error ? err.name : "unknown" },
            "slack signal notice failed",
          ),
        );
      }
    }
    const status = normalized ? "PROCESSED" : "IGNORED";
    await db.webhookEvent.update({
      where: { id: event.id },
      data: { status, processedAt: realClock(), errorPlain: null },
    });
    return { status, accountIds: [...accountIds], signalsOpened: opened };
  } catch (err) {
    await db.webhookEvent.update({
      where: { id: event.id },
      data: {
        status: "FAILED",
        errorPlain: "This event could not be processed; it will be retried.",
      },
    });
    logger.warn(
      { workspaceId, webhookEventId, err: err instanceof Error ? err.name : "unknown" },
      "webhook processing failed",
    );
    throw err;
  }
}
