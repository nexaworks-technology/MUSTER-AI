import type { Integration, Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { ForbiddenError, requirePermission } from "@/lib/auth/permissions";
import { businessClock, todayIn, type Clock } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { formatMoney } from "@/lib/money";
import {
  AccountNotFoundError,
  bookWhere,
  getAccount,
  type Actor,
} from "@/modules/accounts/service";
import { canSeeMoney, redactMoney } from "@/modules/billing/service";
import { loadContext } from "@/modules/health/service";
import {
  PROVIDER_NAMES,
  requestWriteBack,
  WriteBackRefusedError,
} from "@/modules/integrations/service";
import { loadWhitespace } from "./whitespace.service";
import type { Whitespace } from "./whitespace";

const PAGE = 25;
export const STATUSES = ["OPEN", "IN_PROGRESS", "WON", "LOST", "DISMISSED"] as const;
export const STATUS_WORDS: Record<(typeof STATUSES)[number], string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  WON: "Won",
  LOST: "Lost",
  DISMISSED: "Dismissed",
};
const EXPORT_FIELD = "expansionOpportunity";

export class ExpansionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpansionError";
  }
}

export const opportunityQuery = z.object({
  status: z.enum([...STATUSES, "ALL"]).default("OPEN"),
  page: z.coerce.number().int().min(1).default(1),
});

export interface OpportunityRow {
  id: string;
  account: { id: string; name: string };
  /** The signals that raised it, each linking to the record (Rule 1). */
  signals: Array<{ id: string; ruleKey: string; title: string; severity: string; live: boolean }>;
  method: "SEATS_OVER_LIMIT" | "TIER_UPGRADE_DELTA" | null;
  isEstimate: true;
  /** Seats over the limit, when the method is seats (not money). */
  extraSeats: number | null;
  owner: string | null;
  ownerMembershipId: string | null;
  nextStep: string | null;
  nextStepDate: Date | null;
  status: (typeof STATUSES)[number];
  crmExternalId: string | null;
  whitespace: Whitespace | null;
  /** The Expansion Finder's latest usable note, with the estimate placeholder filled by code. */
  finder: { runId: string; note: string; approvalId: string | null } | null;
  canEdit: boolean;
  canExport: boolean;
  /** Present only with revenue access (spec §6N5). */
  estimateMinor?: bigint | null;
  currency?: string | null;
  /** "Estimate", "No price on file", or why there is none; with the method in words. */
  estimateText?: string;
  moneyVisible: boolean;
}

const select = {
  id: true,
  signalIds: true,
  estimateMinor: true,
  currency: true,
  estimateMethod: true,
  ownerMembershipId: true,
  nextStep: true,
  nextStepDate: true,
  status: true,
  crmExternalId: true,
  owner: { select: { user: { select: { name: true, email: true } } } },
  account: { select: { id: true, name: true, ownerMembershipId: true } },
} satisfies Prisma.ExpansionOpportunitySelect;
type Db = Prisma.ExpansionOpportunityGetPayload<{ select: typeof select }>;
type SignalLite = {
  id: string;
  ruleKey: string;
  title: string;
  severity: string;
  status: string;
  values: Prisma.JsonValue;
};

/** The account's owner, a CS Leader or an Admin may work an opportunity (same as the forecast category). */
export function canWork(
  actor: Pick<Actor, "role" | "membershipId">,
  accountOwner: string | null,
): boolean {
  if (actor.role === "ADMIN" || actor.role === "CS_LEADER") return true;
  return actor.role === "CSM" && accountOwner === actor.membershipId;
}

/** The estimate as the card reads it and as a sentence in a note reads it; both name the method. */
function estimateParts(o: Db, extra: number | null): { text: string; phrase: string } {
  if (!o.estimateMethod)
    return {
      text: "No estimate: the account is not over a paid limit.",
      phrase: "no estimate, as the account is not over a paid limit",
    };
  if (o.estimateMinor === null || !o.currency)
    return {
      text: "No price on file: this account's own subscription does not give a price per seat.",
      phrase: "not priced: no price on file for this account's own subscription",
    };
  const total = formatMoney({ minor: o.estimateMinor, currency: o.currency });
  const how =
    o.estimateMethod === "SEATS_OVER_LIMIT" && extra && extra > 0
      ? `${extra} seats × ${formatMoney({ minor: o.estimateMinor / BigInt(extra), currency: o.currency })} per seat, from their subscription`
      : "next plan price minus current plan price, both from their subscriptions";
  return {
    text: `Estimate: ${total} ARR (${how})`,
    phrase: `an estimate of ${total} ARR (${how})`,
  };
}

type FinderRun = {
  id: string;
  triggerId: string;
  output: Prisma.JsonValue;
  effects: Prisma.JsonValue;
};

const PLACEHOLDER = "{{metric.expansion.estimate}}";

/** The latest usable note for an opportunity; the estimate placeholder is filled here, by code. */
function finderFor(runs: FinderRun[], o: Db, phrase: string, visible: boolean) {
  const run = runs.find((r) => r.triggerId === o.id || r.triggerId.startsWith(`${o.id}:`));
  const note = (run?.output as { narrative?: string | null } | null)?.narrative;
  if (!run || !note) return null;
  const approval = (run.effects as Array<{ type: string; id: string }> | null)?.find(
    (e) => e.type === "Approval",
  );
  return {
    runId: run.id,
    note: note.replaceAll(PLACEHOLDER, visible ? phrase : "Restricted"),
    approvalId: approval?.id ?? null,
  };
}

function toRow(
  actor: Actor,
  o: Db,
  signals: Map<string, SignalLite>,
  ws: Whitespace | null,
  exportable: boolean,
  runs: FinderRun[],
): OpportunityRow {
  const sigs = o.signalIds.flatMap((id) => (signals.has(id) ? [signals.get(id)!] : []));
  const seats = sigs.find(
    (s) =>
      s.ruleKey === "seats_near_limit" &&
      typeof (s.values as { seats?: unknown })?.seats === "number",
  );
  const v = (seats?.values ?? {}) as { used?: number; seats?: number };
  const extra =
    o.estimateMethod === "SEATS_OVER_LIMIT" &&
    typeof v.used === "number" &&
    typeof v.seats === "number"
      ? v.used - v.seats
      : null;
  const canEdit = canWork(actor, o.account.ownerMembershipId);
  const parts = estimateParts(o, extra);
  const base = {
    id: o.id,
    account: { id: o.account.id, name: o.account.name },
    signals: sigs.map((s) => ({
      id: s.id,
      ruleKey: s.ruleKey,
      title: s.title,
      severity: s.severity,
      live: s.status === "OPEN" || s.status === "ACKNOWLEDGED",
    })),
    method: o.estimateMethod,
    isEstimate: true as const,
    extraSeats: extra,
    owner: o.owner?.user.name ?? o.owner?.user.email ?? null,
    ownerMembershipId: o.ownerMembershipId,
    nextStep: o.nextStep,
    nextStepDate: o.nextStepDate,
    status: o.status,
    crmExternalId: o.crmExternalId,
    whitespace: ws,
    finder: finderFor(runs, o, parts.phrase, canSeeMoney(actor)),
    canEdit,
    canExport: canEdit && canSeeMoney(actor) && exportable && o.crmExternalId === null,
    estimateMinor: o.estimateMinor,
    currency: o.currency,
    estimateText: parts.text,
  };
  return redactMoney(actor, base, ["estimateMinor", "currency", "estimateText"] as const);
}

const CRM = ["HUBSPOT", "SALESFORCE"] as const;

const finderRuns = (db: ReturnType<typeof scopedDb>, accountIds: string[]) =>
  db.agentRun.findMany({
    where: { agentKey: "expansion-finder", status: "SUCCEEDED", accountId: { in: accountIds } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: { id: true, triggerId: true, output: true, effects: true },
  });

/** A fixed number of reads per page: rows, their signals, whitespace, and the connected CRMs. */
export async function listOpportunities(
  actor: Actor,
  raw: unknown = {},
  clock: Clock = businessClock,
) {
  const grant = requirePermission(actor, "accounts:view");
  const q = opportunityQuery.parse(raw);
  const ctx = await loadContext(actor);
  const asOf = todayIn(ctx.timeZone, clock);
  const db = scopedDb(actor);
  const where: Prisma.ExpansionOpportunityWhereInput = {
    ...(q.status === "ALL"
      ? {}
      : q.status === "OPEN"
        ? { status: { in: ["OPEN", "IN_PROGRESS"] } }
        : { status: q.status }),
    account: bookWhere(actor, grant.scope),
  };
  const [total, rows, crm] = await Promise.all([
    db.expansionOpportunity.count({ where }),
    db.expansionOpportunity.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (q.page - 1) * PAGE,
      take: PAGE,
      select,
    }),
    db.integration.findMany({
      where: { provider: { in: [...CRM] }, status: { not: "DISCONNECTED" } },
      select: { id: true, provider: true, writeBackEnabled: true },
      orderBy: { provider: "asc" },
    }),
  ]);
  const [signals, ws, runs] = await Promise.all([
    db.signal.findMany({
      where: { id: { in: rows.flatMap((r) => r.signalIds) } },
      select: { id: true, ruleKey: true, title: true, severity: true, status: true, values: true },
    }),
    loadWhitespace(db, [...new Set(rows.map((r) => r.account.id))], asOf),
    finderRuns(db, [...new Set(rows.map((r) => r.account.id))]),
  ]);
  const sigById = new Map(signals.map((s) => [s.id, s]));
  return {
    rows: rows.map((r) =>
      toRow(actor, r, sigById, ws.get(r.account.id) ?? null, crm.length > 0, runs),
    ),
    total,
    page: q.page,
    pages: Math.max(1, Math.ceil(total / PAGE)),
    status: q.status,
    asOf,
    crm: crm[0]
      ? { name: PROVIDER_NAMES[crm[0].provider], writeBackEnabled: crm[0].writeBackEnabled }
      : null,
    moneyVisible: canSeeMoney(actor),
  };
}

/** Account 360 › Expansion: the account's opportunities and its whitespace (no money in the latter). */
export async function getAccountExpansion(
  actor: Actor,
  accountId: string,
  clock: Clock = businessClock,
) {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  const ctx = await loadContext(actor);
  const asOf = todayIn(ctx.timeZone, clock);
  const db = scopedDb(actor);
  const [rows, crm, ws] = await Promise.all([
    db.expansionOpportunity.findMany({
      where: { accountId },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select,
    }),
    db.integration.count({
      where: { provider: { in: [...CRM] }, status: { not: "DISCONNECTED" } },
    }),
    loadWhitespace(db, [accountId], asOf),
  ]);
  const [signals, runs] = await Promise.all([
    db.signal.findMany({
      where: { id: { in: rows.flatMap((r) => r.signalIds) } },
      select: { id: true, ruleKey: true, title: true, severity: true, status: true, values: true },
    }),
    finderRuns(db, [accountId]),
  ]);
  const sigById = new Map(signals.map((s) => [s.id, s]));
  return {
    account,
    whitespace: ws.get(accountId)!,
    opportunities: rows.map((r) => toRow(actor, r, sigById, null, crm > 0, runs)),
  };
}

export const opportunityInput = z.object({
  status: z.enum(STATUSES).optional(),
  nextStep: z.string().trim().max(300).nullable().optional(),
  nextStepDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  ownerMembershipId: z.string().min(1).max(60).nullable().optional(),
});

async function loadForWork(actor: Actor, id: string) {
  const db = scopedDb(actor);
  const opp = await db.expansionOpportunity.findUnique({
    where: { workspaceId_id: { workspaceId: actor.workspaceId, id } },
    select,
  });
  if (!opp || !(await getAccount(actor, opp.account.id)))
    throw new ExpansionError("This opportunity does not exist.");
  if (!canWork(actor, opp.account.ownerMembershipId)) throw new ForbiddenError("accounts:edit");
  return opp;
}

/** Status, owner, next step and its date: people's fields; audited with before and after. */
export async function updateOpportunity(actor: Actor, id: string, raw: unknown) {
  const input = opportunityInput.parse(raw);
  const opp = await loadForWork(actor, id);
  const db = scopedDb(actor);
  if (input.ownerMembershipId) {
    const m = await db.membership.findFirst({
      where: { id: input.ownerMembershipId, status: "ACTIVE" },
      select: { id: true },
    });
    if (!m) throw new ExpansionError("That owner is not an active member of this workspace.");
  }
  const data: Prisma.ExpansionOpportunityUncheckedUpdateInput = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.nextStep !== undefined ? { nextStep: input.nextStep || null } : {}),
    ...(input.nextStepDate !== undefined
      ? { nextStepDate: input.nextStepDate ? new Date(`${input.nextStepDate}T00:00:00Z`) : null }
      : {}),
    ...(input.ownerMembershipId !== undefined
      ? { ownerMembershipId: input.ownerMembershipId }
      : {}),
  };
  if (Object.keys(data).length === 0) throw new ExpansionError("Nothing to change.");
  await db.$tenantTransaction(async (tx) => {
    await tx.expansionOpportunity.update({
      where: { workspaceId_id: { workspaceId: actor.workspaceId, id } },
      data,
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "expansion.opportunity_updated",
        targetType: "ExpansionOpportunity",
        targetId: id,
        summary: `Updated the expansion opportunity for ${opp.account.name}`,
        before: {
          status: opp.status,
          nextStep: opp.nextStep,
          nextStepDate: opp.nextStepDate?.toISOString().slice(0, 10) ?? null,
          ownerMembershipId: opp.ownerMembershipId,
        },
        after: input,
      },
      tx,
    );
  });
}

/**
 * Export to the connected CRM through the write-back gate (Rule 7, D-116): refused when the gate is
 * off for that integration or the field is not allowed, an approval is required, and nothing is
 * pushed over a live transport unless WRITE_BACK_LIVE is set. Only a member who can see revenue may
 * ask, because the CRM record carries the estimate.
 */
export async function exportOpportunity(actor: Actor, id: string) {
  if (!canSeeMoney(actor)) throw new ForbiddenError("revenue:view");
  const opp = await loadForWork(actor, id);
  if (opp.crmExternalId) throw new ExpansionError("This opportunity is already in the CRM.");
  const db = scopedDb(actor);
  const crm = (await db.integration.findMany({
    where: { provider: { in: [...CRM] }, status: { not: "DISCONNECTED" } },
    orderBy: { provider: "asc" },
  })) as Integration[];
  const integration = crm.find((i) => i.writeBackEnabled) ?? crm[0];
  if (!integration)
    throw new ExpansionError(
      "No CRM is connected. Connect HubSpot or Salesforce in Settings › Integrations.",
    );
  const name = PROVIDER_NAMES[integration.provider];
  try {
    const r = await requestWriteBack(actor, integration.id, {
      field: EXPORT_FIELD,
      accountId: opp.account.id,
      value: opp.id,
    });
    return { status: "PENDING_APPROVAL" as const, approvalId: r.approvalId, crm: name };
  } catch (e) {
    if (!(e instanceof WriteBackRefusedError)) throw e;
    const off =
      !integration.writeBackEnabled || !integration.writeBackFields.includes(EXPORT_FIELD);
    throw new ExpansionError(
      off ? `Turn on write-back for ${name} to sync. ${e.message}` : e.message,
    );
  }
}
