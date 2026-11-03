import type { Integration } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { env } from "@/lib/config/env";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { requestApproval } from "@/modules/approvals/service";
import type { IntegrationAdapter } from "./adapter";
import { adapterFor } from "./adapters";
import { loadConnection, type ConnectionDeps } from "./connection";
import { PROVIDER_NAMES, recordSourceFor } from "./providers";

/**
 * The write-back gate (Rule 7, ARCHITECTURE §8.1, M5 D2). Read-only is the default: nothing is
 * written to a customer's system unless an Admin turned write-back on for that integration AND
 * listed the field, AND the adapter declares it. Every request then becomes a WRITE_BACK approval
 * (no M5 caller has an automatic level), and the push happens only once it is approved, after
 * the gate is checked again. Every path (refused, requested, pushed, failed) writes an AuditLog row.
 * Live write-back is DEFERRED (founder D2) and enforced in code (D-116): a push over the live
 * transport refuses unless WRITE_BACK_LIVE=true; fixture transports (tests, e2e, demo) push.
 */
export class WriteBackRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteBackRefusedError";
  }
}

export const writeBackChangeInput = z.object({
  /** Our field name, e.g. "ownerMembershipId". */
  field: z.string().min(1),
  accountId: z.string().min(1),
  /** Our value (for the owner: a membership id). */
  value: z.string().min(1),
});

type Who = Pick<Actor, "workspaceId" | "userId"> & { membershipId?: string };

interface WriteBackDeps extends ConnectionDeps {
  adapter?: (provider: Integration["provider"]) => IntegrationAdapter<unknown>;
  /** Overrides WRITE_BACK_LIVE (tests); production reads the env. */
  writeBackLive?: boolean;
}

async function audit(
  who: Who,
  action: string,
  integrationId: string,
  summary: string,
  after?: unknown,
) {
  await writeAudit({
    workspaceId: who.workspaceId,
    actorType: who.userId ? "USER" : "SYSTEM",
    actorId: who.userId ?? null,
    action,
    targetType: "Integration",
    targetId: integrationId,
    summary,
    after,
  });
}

/** The gate itself. Returns the reason it refuses, or null. */
function gate(
  integration: Integration,
  adapter: IntegrationAdapter<unknown>,
  field: string,
): string | null {
  const name = PROVIDER_NAMES[integration.provider];
  if (integration.status === "DISCONNECTED") return `${name} is disconnected.`;
  if (!integration.writeBackEnabled)
    return `Write-back is off for ${name}, so nothing was changed there.`;
  if (!integration.writeBackFields.includes(field))
    return `Write-back to ${name} is not allowed for this field, so nothing was changed there.`;
  if (!adapter.writeBack?.fields.some((f) => f.key === field))
    return `${name} does not support writing this field.`;
  return null;
}

/** Our ids → the provider's ids, through the same ExternalRef mappings the sync wrote. */
async function providerIds(
  who: Who,
  integration: Integration,
  change: z.infer<typeof writeBackChangeInput>,
) {
  const source = recordSourceFor(integration.provider);
  const db = scopedDb(who);
  const [account, owner] = await Promise.all([
    db.externalRef.findFirst({
      where: { source: source ?? undefined, objectType: "Account", internalId: change.accountId },
      select: { externalId: true },
    }),
    change.field === "ownerMembershipId"
      ? db.externalRef.findFirst({
          where: { source: source ?? undefined, objectType: "Owner", internalId: change.value },
          select: { externalId: true },
        })
      : Promise.resolve({ externalId: change.value }),
  ]);
  const name = PROVIDER_NAMES[integration.provider];
  if (!source || !account) return { refused: `This account is not linked to a ${name} record.` };
  if (!owner) return { refused: `That member is not matched to a ${name} owner.` };
  return { externalId: account.externalId, value: owner.externalId };
}

/** Request a write-back: refused by the gate, or a WRITE_BACK approval (audited either way). */
export async function requestWriteBack(
  who: Who,
  integrationId: string,
  raw: unknown,
  deps: WriteBackDeps = {},
) {
  const change = writeBackChangeInput.parse(raw);
  const integration = await scopedDb(who).integration.findUniqueOrThrow({
    where: { id: integrationId },
  });
  const adapter = (deps.adapter ?? adapterFor)(integration.provider);
  const name = PROVIDER_NAMES[integration.provider];
  const refused =
    gate(integration, adapter, change.field) ??
    (await providerIds(who, integration, change)).refused;
  if (refused) {
    await audit(who, "integration.writeback_refused", integrationId, refused, {
      field: change.field,
      accountId: change.accountId,
    });
    throw new WriteBackRefusedError(refused);
  }
  const label = adapter.writeBack!.fields.find((f) => f.key === change.field)!.label.toLowerCase();
  const approval = await requestApproval(who, {
    accountId: change.accountId,
    kind: "WRITE_BACK",
    reason: `Update the ${label} in ${name}`,
    proof: [
      { sourceType: "Account", sourceId: change.accountId, label: "The account" },
      {
        sourceType: "Integration",
        sourceId: integrationId,
        label: `${name} (write-back on for this field)`,
      },
    ],
    proposedByMembershipId: who.membershipId,
    sourceKey: `writeback:${integrationId}:${change.accountId}:${change.field}:${change.value}`,
    writeBack: { integrationId, ...change },
  });
  await audit(
    who,
    "integration.writeback_requested",
    integrationId,
    `Asked for approval to update the ${label} in ${name}`,
    {
      approvalId: approval.id,
      field: change.field,
      accountId: change.accountId,
    },
  );
  return { status: "PENDING_APPROVAL" as const, approvalId: approval.id };
}

const approvedPayload = z.object({
  writeBack: z.object({
    integrationId: z.string(),
    field: z.string(),
    accountId: z.string(),
    value: z.string(),
  }),
});

/** Runs an approved WRITE_BACK once. Called by approvals.approve; re-checks the gate first. */
export async function executeApprovedWriteBack(
  who: Who,
  approvalId: string,
  deps: WriteBackDeps = {},
): Promise<{ status: "PUSHED" | "REFUSED" | "FAILED" | "ALREADY_PUSHED"; plain: string }> {
  const db = scopedDb(who);
  const approval = await db.approval.findUniqueOrThrow({ where: { id: approvalId } });
  if (approval.kind !== "WRITE_BACK" || !["APPROVED", "EDITED_APPROVED"].includes(approval.status))
    throw new WriteBackRefusedError("Only an approved write-back can be pushed.");
  const { writeBack: change } = approvedPayload.parse(approval.payload);
  const done = await db.auditLog.findFirst({
    where: {
      action: "integration.writeback_pushed",
      targetId: change.integrationId,
      summary: { contains: approvalId },
    },
    select: { id: true },
  });
  if (done) return { status: "ALREADY_PUSHED", plain: "This change was already written." };
  const integration = await db.integration.findUniqueOrThrow({
    where: { id: change.integrationId },
  });
  const name = PROVIDER_NAMES[integration.provider];
  let adapter: IntegrationAdapter<unknown>;
  try {
    adapter = (deps.adapter ?? adapterFor)(integration.provider);
  } catch {
    // Already approved: never throw here, record why nothing was written.
    const plain = `${name} has no connector that can write, so nothing was changed there.`;
    await audit(
      who,
      "integration.writeback_refused",
      integration.id,
      `${plain} (approval ${approvalId})`,
    );
    return { status: "REFUSED", plain };
  }
  const ids = await providerIds(who, integration, change);
  const refused = gate(integration, adapter, change.field) ?? ids.refused;
  if (refused || !ids.externalId || !ids.value) {
    const plain = refused ?? "The change could not be mapped.";
    await audit(
      who,
      "integration.writeback_refused",
      integration.id,
      `${plain} (approval ${approvalId})`,
    );
    return { status: "REFUSED", plain };
  }
  let notLive: string | null = null;
  try {
    const { context } = await loadConnection(who, integration.id, {
      ...deps,
      adapter: () => adapter,
    });
    // D-116 (founder, 2026-11-04): a push over the live transport needs WRITE_BACK_LIVE=true. The
    // check is on the transport actually in use, so a deployment cannot write to a customer's
    // system by an Admin's switch and an approval alone while live write-back is deferred.
    if (
      context.transport.mode === "live" &&
      !(deps.writeBackLive ?? env().WRITE_BACK_LIVE === "true")
    )
      notLive = `Writing to ${name} for real is switched off for this deployment (WRITE_BACK_LIVE is not set), so nothing was changed there.`;
    else
      await adapter.writeBack!.push(context, {
        field: change.field,
        accountId: change.accountId,
        externalId: ids.externalId,
        value: ids.value,
      });
  } catch (err) {
    const d = adapter.describeError(err);
    await audit(
      who,
      "integration.writeback_failed",
      integration.id,
      `${d.plain} (approval ${approvalId})`,
    );
    return { status: "FAILED", plain: d.plain };
  }
  if (notLive) {
    await audit(
      who,
      "integration.writeback_refused",
      integration.id,
      `${notLive} (approval ${approvalId})`,
      { field: change.field, accountId: change.accountId, transport: "live" },
    );
    return { status: "REFUSED", plain: notLive };
  }
  const plain = `Updated in ${name} (approval ${approvalId}).`;
  await audit(who, "integration.writeback_pushed", integration.id, plain, {
    field: change.field,
    accountId: change.accountId,
  });
  return { status: "PUSHED", plain };
}

export const writeBackSettingsInput = z.object({
  enabled: z.boolean(),
  fields: z.array(z.string().min(1)).max(20).default([]),
});

/** Settings › Integrations: the write-back switch and field picker (Admin only, audited). */
export async function setWriteBack(
  actor: Actor,
  integrationId: string,
  raw: unknown,
  deps: WriteBackDeps = {},
) {
  requirePermission(actor, "integrations:manage");
  const input = writeBackSettingsInput.parse(raw);
  const db = scopedDb(actor);
  const integration = await db.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const adapter = (deps.adapter ?? adapterFor)(integration.provider);
  const declared = new Set(adapter.writeBack?.fields.map((f) => f.key) ?? []);
  const fields = input.enabled ? [...new Set(input.fields)] : [];
  if (fields.some((f) => !declared.has(f)))
    throw new WriteBackRefusedError(
      `${PROVIDER_NAMES[integration.provider]} does not support writing that field.`,
    );
  if (input.enabled && fields.length === 0)
    throw new WriteBackRefusedError("Choose at least one field to allow, or leave write-back off.");
  await db.$tenantTransaction(async (tx) => {
    await tx.integration.update({
      where: { id: integrationId },
      data: { writeBackEnabled: input.enabled, writeBackFields: fields },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "integration.writeback_changed",
        targetType: "Integration",
        targetId: integrationId,
        summary: input.enabled
          ? `Allowed write-back to ${PROVIDER_NAMES[integration.provider]} for: ${fields.map((f) => adapter.writeBack!.fields.find((x) => x.key === f)!.label).join(", ")}`
          : `Turned write-back to ${PROVIDER_NAMES[integration.provider]} off`,
        before: { enabled: integration.writeBackEnabled, fields: integration.writeBackFields },
        after: { enabled: input.enabled, fields },
      },
      tx,
    );
  });
}
