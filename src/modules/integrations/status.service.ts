import type { IntegrationProvider } from "@prisma/client";
import { z } from "zod";
import { env } from "@/lib/config/env";
import { requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { ADAPTERS } from "./adapters";
import { openCredentials } from "./credentials";
import { ConnectError } from "./connections.service";
import { PROVIDER_NAMES } from "./providers";
import { linkSlackMembers } from "./slack/service";
import { enqueueSync } from "./sync.jobs";

/**
 * What Settings › Integrations shows (§6B "every sync shows last-run time and errors in plain
 * words"). Credentials never leave the database through here: the query selects named columns
 * only, and only whether a webhook secret exists is derived (by the caller's connect form).
 */
const countsSchema = z
  .object({
    created: z.number().default(0),
    updated: z.number().default(0),
    unchanged: z.number().default(0),
    rejected: z.number().default(0),
    unmatched: z.number().default(0),
    archived: z.number().default(0),
    conflicts: z.number().default(0),
    problems: z
      .array(z.object({ kind: z.string(), objectType: z.string(), reason: z.string() }))
      .default([]),
  })
  .catch({
    created: 0,
    updated: 0,
    unchanged: 0,
    rejected: 0,
    unmatched: 0,
    archived: 0,
    conflicts: 0,
    problems: [],
  });

export interface ProviderCard {
  provider: IntegrationProvider;
  name: string;
  category: string;
  authKind: "oauth2" | "apiKey";
  hasWebhooks: boolean;
  writeBackFields: ReadonlyArray<{ key: string; label: string }>;
  /** Slack only: members linked by verified email. */
  slackLinked: number | null;
  /** Usage API only: the key (never the key itself), the Segment address and the last batch. */
  usageApi: {
    keyLast4: string | null;
    keyRotatedAt: Date | null;
    hasSegmentSecret: boolean;
    endpoint: string;
    segmentUrl: string | null;
    batches: number;
    lastBatch: {
      appliedAt: Date;
      events: number;
      unmatched: Array<{ groupId: string | null; reason: string }>;
      skipped: string[];
    } | null;
  } | null;
  integration: {
    id: string;
    status: "CONNECTED" | "ERROR" | "DISCONNECTED";
    externalAccountId: string | null;
    connectedAt: Date;
    lastSyncAt: Date | null;
    lastErrorPlain: string | null;
    writeBackEnabled: boolean;
    writeBackFields: string[];
    webhookUrl: string | null;
  } | null;
  lastRun: {
    status: "RUNNING" | "SUCCEEDED" | "FAILED";
    trigger: string;
    startedAt: Date;
    finishedAt: Date | null;
    errorPlain: string | null;
    counts: z.infer<typeof countsSchema>;
  } | null;
}

/** One card per registered connector, in launch order. Admin only. */
export async function listIntegrations(actor: Actor): Promise<ProviderCard[]> {
  requirePermission(actor, "integrations:manage");
  const db = scopedDb(actor);
  const rows = await db.integration.findMany({
    select: {
      id: true,
      provider: true,
      status: true,
      externalAccountId: true,
      connectedAt: true,
      lastSyncAt: true,
      lastErrorPlain: true,
      writeBackEnabled: true,
      writeBackFields: true,
    },
  });
  const runs = rows.length
    ? await db.syncJob.findMany({
        where: { integrationId: { in: rows.map((r) => r.id) } },
        orderBy: { startedAt: "desc" },
        distinct: ["integrationId"],
      })
    : [];
  const slackLinked = await db.slackUserLink.count();
  const usageRow = rows.find((r) => r.provider === "USAGE_API");
  const usageApi = usageRow ? await usageApiInfo(actor, usageRow.id) : null;
  const order: IntegrationProvider[] = [
    "HUBSPOT",
    "SALESFORCE",
    "STRIPE",
    "CHARGEBEE",
    "USAGE_API",
    "MIXPANEL",
    "AMPLITUDE",
    "SLACK",
  ];
  return order
    .filter((p) => ADAPTERS[p])
    .map((provider) => {
      const adapter = ADAPTERS[provider]!;
      const row = rows.find((r) => r.provider === provider);
      const run = row ? runs.find((j) => j.integrationId === row.id) : undefined;
      return {
        provider,
        name: PROVIDER_NAMES[provider],
        category: adapter.category,
        authKind: adapter.auth.kind,
        hasWebhooks: Boolean(adapter.webhook),
        writeBackFields: adapter.writeBack?.fields ?? [],
        slackLinked: provider === "SLACK" ? slackLinked : null,
        usageApi:
          provider === "USAGE_API"
            ? (usageApi ?? {
                keyLast4: null,
                keyRotatedAt: null,
                hasSegmentSecret: false,
                endpoint: `${env().APP_URL}/api/usage/v1`,
                segmentUrl: null,
                batches: 0,
                lastBatch: null,
              })
            : null,
        integration: row
          ? {
              ...row,
              webhookUrl: adapter.webhook
                ? `${env().APP_URL}/api/integrations/${provider.toLowerCase()}/webhook/${row.id}`
                : null,
            }
          : null,
        lastRun: run
          ? {
              status: run.status,
              trigger: run.trigger,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
              errorPlain: run.errorPlain,
              counts: countsSchema.parse(run.counts),
            }
          : null,
      };
    });
}

const unmatchedSchema = z
  .array(z.object({ groupId: z.string().nullable(), reason: z.string() }))
  .catch([]);
const skippedSchema = z.array(z.string()).catch([]);

async function usageApiInfo(
  actor: Actor,
  integrationId: string,
): Promise<ProviderCard["usageApi"]> {
  const db = scopedDb(actor);
  const [row, batches, last] = await Promise.all([
    db.integration.findUniqueOrThrow({
      where: { id: integrationId },
      select: { credentialsEnc: true, ingestKeyLast4: true, ingestKeyRotatedAt: true },
    }),
    db.usageIngestBatch.count({ where: { integrationId } }),
    db.usageIngestBatch.findFirst({ where: { integrationId }, orderBy: { appliedAt: "desc" } }),
  ]);
  const base = `${env().APP_URL}/api/usage/v1`;
  return {
    keyLast4: row.ingestKeyLast4,
    keyRotatedAt: row.ingestKeyRotatedAt,
    hasSegmentSecret: Boolean(openCredentials(row.credentialsEnc).webhookSecret),
    endpoint: base,
    segmentUrl: `${base}/batch?integration=${integrationId}`,
    batches,
    lastBatch: last
      ? {
          appliedAt: last.appliedAt,
          events: last.events,
          unmatched: unmatchedSchema.parse(last.unmatched),
          skipped: skippedSchema.parse(last.skipped),
        }
      : null,
  };
}

/** "Link Slack members" (Admin): re-reads Slack's members and links verified emails. */
export async function relinkSlackMembers(actor: Actor) {
  requirePermission(actor, "integrations:manage");
  const r = await linkSlackMembers(actor);
  if (r.notConnected) throw new ConnectError("Slack is not connected.");
  return r;
}

/** "Run sync now": Admin only, own integration only, connected only. */
export async function runSyncNow(actor: Actor, integrationId: string) {
  requirePermission(actor, "integrations:manage");
  const row = await scopedDb(actor).integration.findUnique({
    where: { id: integrationId },
    select: { id: true, status: true, provider: true },
  });
  if (!row) throw new ConnectError("This integration does not exist.");
  if (row.provider === "SLACK") throw new ConnectError("Slack has nothing to sync.");
  if (row.provider === "USAGE_API")
    throw new ConnectError(
      "The Usage API is pushed to: it receives events and has nothing to sync.",
    );
  if (row.status === "DISCONNECTED")
    throw new ConnectError(`${PROVIDER_NAMES[row.provider]} is disconnected. Connect it first.`);
  return enqueueSync(actor, row.id, "MANUAL");
}
