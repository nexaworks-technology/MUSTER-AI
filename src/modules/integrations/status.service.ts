import type { IntegrationProvider } from "@prisma/client";
import { z } from "zod";
import { env } from "@/lib/config/env";
import { requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { ADAPTERS } from "./adapters";
import { ConnectError } from "./connections.service";
import { PROVIDER_NAMES } from "./providers";
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
  const order: IntegrationProvider[] = ["HUBSPOT", "SALESFORCE", "STRIPE", "CHARGEBEE", "SLACK"];
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

/** "Run sync now": Admin only, own integration only, connected only. */
export async function runSyncNow(actor: Actor, integrationId: string) {
  requirePermission(actor, "integrations:manage");
  const row = await scopedDb(actor).integration.findUnique({
    where: { id: integrationId },
    select: { id: true, status: true, provider: true },
  });
  if (!row) throw new ConnectError("This integration does not exist.");
  if (row.status === "DISCONNECTED")
    throw new ConnectError(`${PROVIDER_NAMES[row.provider]} is disconnected. Connect it first.`);
  return enqueueSync(actor, row.id, "MANUAL");
}
