import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { can, ForbiddenError, requirePermission } from "@/lib/auth/permissions";
import { fieldCipher } from "@/lib/crypto";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import { formatMoney } from "@/lib/money";
import type { TimelineItem } from "@/modules/accounts/schemas";
import {
  AccountNotFoundError,
  getAccount,
  requireEditableAccount,
  type Actor,
} from "@/modules/accounts/service";
import { currentContract, deriveRevenueEvents } from "./revenue";

/**
 * Contracts, subscriptions, invoices and rule-derived revenue events (spec §6A3, §6N3).
 * Field-level protection: money values and decrypted terms leave this module only for members
 * with revenue:view (`redactFinancials`). Terms and pricing notes are stored encrypted.
 */
type Tx = Prisma.TransactionClient;

/**
 * Re-derives an account's revenue events, ARR and renewal date from its contracts. Idempotent:
 * events are upserted by (sourceType, sourceId, type) and rule events no longer implied are removed.
 */
export async function recomputeCommercials(
  tx: Tx,
  workspaceId: string,
  accountId: string,
  asOf = new Date(),
) {
  const contracts = await tx.contract.findMany({ where: { accountId } });
  const derived = deriveRevenueEvents(contracts, asOf);
  const keep = new Set(derived.map((e) => `${e.sourceType}:${e.sourceId}:${e.type}`));
  const existing = await tx.revenueEvent.findMany({ where: { accountId, computedBy: "RULE" } });
  const stale = existing
    .filter((e) => !keep.has(`${e.sourceType}:${e.sourceId}:${e.type}`))
    .map((e) => e.id);
  if (stale.length > 0) await tx.revenueEvent.deleteMany({ where: { id: { in: stale } } });
  for (const e of derived) {
    await tx.revenueEvent.upsert({
      where: {
        workspaceId_sourceType_sourceId_type: {
          workspaceId,
          sourceType: e.sourceType,
          sourceId: e.sourceId,
          type: e.type,
        },
      },
      create: { workspaceId, accountId, ...e, computedBy: "RULE" },
      update: {
        deltaArrMinor: e.deltaArrMinor,
        currency: e.currency,
        effectiveDate: e.effectiveDate,
      },
    });
  }
  const current = currentContract(contracts, asOf);
  await tx.account.update({
    where: { id: accountId },
    data: {
      arrMinor: current?.valueMinor ?? null,
      arrCurrency: current?.valueMinor !== null && current ? current.currency : null,
      renewalDate: current?.renewalDate ?? null,
    },
  });
}

export const contractInput = z.object({
  id: z.string().optional(),
  accountId: z.string().min(1),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullable().optional(),
  renewalDate: z.coerce.date().nullable().optional(),
  autoRenew: z.boolean().nullable().optional(),
  noticePeriodDays: z.number().int().min(0).max(365).nullable().optional(),
  valueMinor: z.bigint().nonnegative().nullable().optional(),
  currency: z.string().length(3).default("USD"),
  seatsPurchased: z.number().int().min(0).nullable().optional(),
  creditsPurchased: z.number().int().min(0).nullable().optional(),
  terms: z.string().max(20_000).nullable().optional(),
  pricingNotes: z.string().max(5_000).nullable().optional(),
  status: z.enum(["ACTIVE", "ENDED", "CANCELLED"]).default("ACTIVE"),
});

/** Creates or updates a contract. Recording values or terms needs revenue access. */
export async function saveContract(actor: Actor, raw: z.input<typeof contractInput>) {
  const input = contractInput.parse(raw);
  requirePermission(actor, "revenue:view");
  await requireEditableAccount(actor, input.accountId);
  const cipher = fieldCipher();
  const data = {
    accountId: input.accountId,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    renewalDate: input.renewalDate ?? null,
    autoRenew: input.autoRenew ?? null,
    noticePeriodDays: input.noticePeriodDays ?? null,
    valueMinor: input.valueMinor ?? null,
    currency: input.currency,
    seatsPurchased: input.seatsPurchased ?? null,
    creditsPurchased: input.creditsPurchased ?? null,
    termsEnc: cipher.encryptNullable(input.terms),
    pricingNotesEnc: cipher.encryptNullable(input.pricingNotes),
    status: input.status,
  };
  return scopedDb(actor).$tenantTransaction(async (tx) => {
    const contract = input.id
      ? await tx.contract.update({ where: { id: input.id }, data })
      : await tx.contract.create({
          data: { workspaceId: actor.workspaceId, source: "MANUAL", ...data },
        });
    await recomputeCommercials(tx, actor.workspaceId, input.accountId);
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: input.id ? "contract.updated" : "contract.created",
        targetType: "Contract",
        targetId: contract.id,
        summary: input.id ? "Updated a contract" : "Added a contract",
        // Terms and pricing notes are never copied into the audit trail.
        after: {
          startDate: data.startDate,
          renewalDate: data.renewalDate,
          seatsPurchased: data.seatsPurchased,
          status: data.status,
        },
      },
      tx,
    );
    return contract;
  });
}

// ─── Read model with field-level protection ─────────────────────────────────

export async function getBilling(actor: Actor, accountId: string) {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  const db = scopedDb(actor);
  const [contracts, subscriptions, invoices, revenueEvents] = await Promise.all([
    db.contract.findMany({ where: { accountId }, orderBy: [{ startDate: "desc" }, { id: "asc" }] }),
    db.subscription.findMany({ where: { accountId }, orderBy: { createdAt: "desc" } }),
    db.invoice.findMany({
      where: { accountId },
      orderBy: [{ issuedAt: "desc" }, { id: "asc" }],
      take: 24,
    }),
    db.revenueEvent.findMany({
      where: { accountId },
      orderBy: [{ effectiveDate: "desc" }, { id: "asc" }],
    }),
  ]);
  return redactFinancials(actor, {
    account: {
      id: account.id,
      arrMinor: account.arr?.minor ?? null,
      arrCurrency: account.arr?.currency ?? null,
    },
    currentContractId: currentContract(contracts, new Date())?.id ?? null,
    contracts,
    subscriptions,
    invoices,
    revenueEvents,
  });
}

type BillingRows = {
  account: { id: string; arrMinor: bigint | null; arrCurrency: string | null };
  currentContractId: string | null;
  contracts: Prisma.ContractGetPayload<object>[];
  subscriptions: Prisma.SubscriptionGetPayload<object>[];
  invoices: Prisma.InvoiceGetPayload<object>[];
  revenueEvents: Prisma.RevenueEventGetPayload<object>[];
};

/**
 * The single projection that decides what money a member may see (INTERP-4). Without
 * revenue:view, money keys are removed entirely (not zeroed) and terms are never decrypted.
 */
export function redactFinancials(
  actor: Pick<Actor, "role" | "canViewRevenue" | "bookScope">,
  rows: BillingRows,
) {
  const moneyVisible = can(actor, "revenue:view") !== null;
  const cipher = moneyVisible ? fieldCipher() : null;
  const contracts = rows.contracts.map(({ termsEnc, pricingNotesEnc, valueMinor, ...c }) =>
    cipher
      ? {
          ...c,
          valueMinor,
          terms: cipher.decryptNullable(termsEnc),
          pricingNotes: cipher.decryptNullable(pricingNotesEnc),
        }
      : c,
  );
  const subscriptions = rows.subscriptions.map(({ amountMinor, ...s }) =>
    moneyVisible ? { ...s, amountMinor } : s,
  );
  const invoices = rows.invoices.map(({ amountMinor, ...i }) =>
    moneyVisible ? { ...i, amountMinor } : i,
  );
  const revenueEvents = rows.revenueEvents.map(({ deltaArrMinor, ...e }) =>
    moneyVisible ? { ...e, deltaArrMinor } : e,
  );
  const { arrMinor, arrCurrency, ...account } = rows.account;
  return {
    moneyVisible,
    currentContractId: rows.currentContractId,
    account: moneyVisible ? { ...account, arrMinor, arrCurrency } : account,
    contracts: contracts as Array<
      (typeof contracts)[number] & {
        valueMinor?: bigint | null;
        terms?: string | null;
        pricingNotes?: string | null;
      }
    >,
    subscriptions: subscriptions as Array<
      (typeof subscriptions)[number] & { amountMinor?: bigint }
    >,
    invoices: invoices as Array<(typeof invoices)[number] & { amountMinor?: bigint }>,
    revenueEvents: revenueEvents as Array<
      (typeof revenueEvents)[number] & { deltaArrMinor?: bigint }
    >,
  };
}

export type BillingView = Awaited<ReturnType<typeof getBilling>>;

/** Thrown for a forbidden write; re-exported so actions can map it to a plain message. */
export { ForbiddenError };

// ─── Timeline source ─────────────────────────────────────────────────────────

const REVENUE_LABEL = {
  NEW: "New customer ARR",
  EXPANSION: "ARR expansion",
  CONTRACTION: "ARR contraction",
  CHURN: "Churn",
  REACTIVATION: "Reactivation",
} as const;

/** Contract starts/ends, invoices issued/paid/failed and ARR movements. Money only if visible. */
export async function billingTimeline(
  db: ScopedDb,
  accountId: string,
  upTo: Date,
  take: number,
  moneyVisible: boolean,
): Promise<TimelineItem[]> {
  const amount = (minor: bigint, currency: string) =>
    moneyVisible ? ` (${formatMoney({ minor, currency })})` : "";
  const [contracts, invoices, events] = await Promise.all([
    db.contract.findMany({
      where: { accountId, startDate: { lte: upTo } },
      orderBy: { startDate: "desc" },
      take,
    }),
    db.invoice.findMany({
      where: { accountId, issuedAt: { lte: upTo } },
      orderBy: { issuedAt: "desc" },
      take,
    }),
    db.revenueEvent.findMany({
      where: { accountId, effectiveDate: { lte: upTo } },
      orderBy: { effectiveDate: "desc" },
      take,
    }),
  ]);
  const items: TimelineItem[] = [];
  for (const c of contracts) {
    items.push({
      key: `contract:${c.id}:start`,
      at: c.startDate,
      kind: "contract",
      title: "Contract started",
      sourceType: "Contract",
      sourceId: c.id,
    });
    if (c.status !== "ACTIVE" && c.endDate) {
      items.push({
        key: `contract:${c.id}:end`,
        at: c.endDate,
        kind: "contract",
        title: `Contract ${c.status === "CANCELLED" ? "cancelled" : "ended"}`,
        sourceType: "Contract",
        sourceId: c.id,
      });
    }
  }
  for (const i of invoices) {
    items.push({
      key: `invoice:${i.id}:issued`,
      at: i.issuedAt,
      kind: "invoice",
      title: `Invoice ${i.number} issued${amount(i.amountMinor, i.currency)}`,
      sourceType: "Invoice",
      sourceId: i.id,
    });
    if (i.paidAt)
      items.push({
        key: `invoice:${i.id}:paid`,
        at: i.paidAt,
        kind: "invoice",
        title: `Invoice ${i.number} paid`,
        sourceType: "Invoice",
        sourceId: i.id,
      });
    if (i.lastFailedAt) {
      items.push({
        key: `invoice:${i.id}:failed`,
        at: i.lastFailedAt,
        kind: "invoice",
        title: `Payment failed for invoice ${i.number}${i.failureCount > 1 ? ` (${i.failureCount} attempts)` : ""}`,
        sourceType: "Invoice",
        sourceId: i.id,
      });
    }
  }
  for (const e of events) {
    items.push({
      key: `revenue:${e.id}`,
      at: e.effectiveDate,
      kind: "revenue",
      title: `${REVENUE_LABEL[e.type]}${amount(e.deltaArrMinor < 0n ? -e.deltaArrMinor : e.deltaArrMinor, e.currency)}`,
      sourceType: "RevenueEvent",
      sourceId: e.id,
    });
  }
  return items.filter((i) => i.at <= upTo);
}
