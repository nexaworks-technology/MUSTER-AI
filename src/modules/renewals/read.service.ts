import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { ForbiddenError, requirePermission } from "@/lib/auth/permissions";
import {
  addDays,
  businessClock,
  daysBetween,
  calendarDateOf,
  todayIn,
  utcMidnight,
  type CalendarDate,
  type Clock,
} from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import {
  AccountNotFoundError,
  bookWhere,
  getAccount,
  type Actor,
} from "@/modules/accounts/service";
import { canSeeMoney, redactMoney } from "@/modules/billing/service";
import { loadContext } from "@/modules/health/service";
import type { Factor } from "./confidence";
import { disagreement, forecast, type Forecast } from "./forecast";
import { FORECAST_CATEGORIES } from "./schemas";

const PAGE = 25;

export const renewalListQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((n) => [30, 60, 90, 180, 365].includes(n))
    .default(90),
  owner: z.string().min(1).optional(),
  band: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

export class RenewalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenewalError";
  }
}

export interface RenewalRow {
  id: string;
  account: { id: string; name: string; owner: string | null };
  renewalDate: Date;
  daysToRenewal: number;
  noticeDeadline: Date | null;
  confidence: number;
  band: "HIGH" | "MEDIUM" | "LOW";
  /** Every factor with its points, reason and source records (Rule 1). */
  reasons: Factor[];
  category: (typeof FORECAST_CATEGORIES)[number] | null;
  categoryNote: string | null;
  categorySetBy: string | null;
  disagreement: ReturnType<typeof disagreement>;
  canCategorise: boolean;
  /** Present only with revenue access (spec §6N5). */
  arrMinor?: bigint | null;
  currency?: string | null;
  moneyVisible: boolean;
}

const OPEN = ["UPCOMING", "IN_PROGRESS"] as const;

const rowSelect = {
  id: true,
  renewalDate: true,
  noticeDeadline: true,
  arrAtRiskMinor: true,
  currency: true,
  confidence: true,
  confidenceBand: true,
  confidenceReasons: true,
  forecastCategory: true,
  forecastNote: true,
  setBy: { select: { user: { select: { name: true, email: true } } } },
  account: {
    select: {
      id: true,
      name: true,
      ownerMembershipId: true,
      owner: { select: { user: { select: { name: true, email: true } } } },
    },
  },
} satisfies Prisma.RenewalSelect;

type DbRow = Prisma.RenewalGetPayload<{ select: typeof rowSelect }>;

function toRow(actor: Actor, r: DbRow, asOf: CalendarDate): RenewalRow {
  const base = {
    id: r.id,
    account: {
      id: r.account.id,
      name: r.account.name,
      owner: r.account.owner?.user.name ?? r.account.owner?.user.email ?? null,
    },
    renewalDate: r.renewalDate,
    daysToRenewal: daysBetween(asOf, calendarDateOf(r.renewalDate)),
    noticeDeadline: r.noticeDeadline,
    confidence: r.confidence,
    band: r.confidenceBand,
    reasons: r.confidenceReasons as unknown as Factor[],
    category: r.forecastCategory,
    categoryNote: r.forecastNote,
    categorySetBy: r.setBy?.user.name ?? r.setBy?.user.email ?? null,
    disagreement: disagreement(r.confidenceBand, r.forecastCategory),
    canCategorise: canCategorise(actor, r.account.ownerMembershipId),
    arrMinor: r.arrAtRiskMinor,
    currency: r.currency,
  };
  return redactMoney(actor, base, ["arrMinor", "currency"] as const);
}

/**
 * /renewals: open renewals in the member's book inside the window, lowest confidence first, then
 * by date. The forecast sums every open renewal in the window (not just the page) and is only
 * returned to members with revenue access. A fixed number of queries per page.
 */
export async function listRenewals(actor: Actor, raw: unknown = {}, clock: Clock = businessClock) {
  const grant = requirePermission(actor, "accounts:view");
  const q = renewalListQuery.parse(raw);
  const ctx = await loadContext(actor);
  const asOf = todayIn(ctx.timeZone, clock);
  const db = scopedDb(actor);
  const where: Prisma.RenewalWhereInput = {
    stage: { in: [...OPEN] },
    renewalDate: { gte: utcMidnight(asOf), lte: utcMidnight(addDays(asOf, q.days)) },
    ...(q.band ? { confidenceBand: q.band } : {}),
    account: {
      AND: [bookWhere(actor, grant.scope), q.owner ? { ownerMembershipId: q.owner } : {}],
    },
  };
  const money = canSeeMoney(actor);
  const [total, rows, all] = await Promise.all([
    db.renewal.count({ where }),
    db.renewal.findMany({
      where,
      orderBy: [{ confidence: "asc" }, { renewalDate: "asc" }, { id: "asc" }],
      skip: (q.page - 1) * PAGE,
      take: PAGE,
      select: rowSelect,
    }),
    money
      ? db.renewal.findMany({
          where,
          select: {
            id: true,
            arrAtRiskMinor: true,
            currency: true,
            confidenceBand: true,
            forecastCategory: true,
          },
        })
      : Promise.resolve(null),
  ]);
  const sums: Forecast | null = all
    ? forecast(
        all.map((r) => ({
          id: r.id,
          arrMinor: r.arrAtRiskMinor,
          currency: r.currency,
          band: r.confidenceBand,
          category: r.forecastCategory,
        })),
        ctx.baseCurrency,
      )
    : null;
  return {
    rows: rows.map((r) => toRow(actor, r, asOf)),
    total,
    page: q.page,
    pages: Math.max(1, Math.ceil(total / PAGE)),
    asOf,
    days: q.days,
    forecast: sums,
    moneyVisible: money,
  };
}

/** Account 360 › Renewal: every renewal on the account (open first), with reasons. */
export async function getAccountRenewals(
  actor: Actor,
  accountId: string,
  clock: Clock = businessClock,
) {
  const account = await getAccount(actor, accountId);
  if (!account) throw new AccountNotFoundError();
  const ctx = await loadContext(actor);
  const asOf = todayIn(ctx.timeZone, clock);
  const db = scopedDb(actor);
  const [rows, outcomes] = await Promise.all([
    db.renewal.findMany({
      where: { accountId },
      orderBy: { renewalDate: "desc" },
      select: { ...rowSelect, stage: true },
    }),
    db.renewalOutcome.findMany({
      where: { accountId },
      orderBy: [{ occurredOn: "desc" }, { createdAt: "desc" }],
    }),
  ]);
  const open = rows.filter((r) => r.stage === "UPCOMING" || r.stage === "IN_PROGRESS");
  // The effective outcome of a renewal is the one no other row corrects.
  const corrected = new Set(outcomes.flatMap((o) => (o.supersedesId ? [o.supersedesId] : [])));
  const outcomeOf = new Map(
    outcomes.filter((o) => !corrected.has(o.id)).map((o) => [o.renewalId, o]),
  );
  return {
    account,
    asOf,
    open: open.map((r) => toRow(actor, r, asOf)).reverse(),
    past: rows
      .filter((r) => !open.includes(r))
      .map((r) => {
        const o = outcomeOf.get(r.id);
        const base = {
          id: r.id,
          renewalDate: r.renewalDate,
          stage: r.stage,
          outcome: o
            ? {
                result: o.result,
                occurredOn: o.occurredOn,
                detectedVia: o.detectedVia,
                // The forecast as it stood then, frozen on the outcome (never read from the live row).
                forecast: {
                  asOf: o.forecastAsOf,
                  confidence: o.forecastConfidence,
                  band: o.forecastBand,
                  category: o.forecastCategory,
                },
                outcomeArrMinor: o.outcomeArrMinor,
                currency: o.currency,
                forecastArrAtRiskMinor: o.forecastArrAtRiskMinor,
              }
            : null,
        };
        return {
          ...base,
          outcome: base.outcome
            ? redactMoney(actor, base.outcome, [
                "outcomeArrMinor",
                "currency",
                "forecastArrAtRiskMinor",
              ] as const)
            : null,
        };
      }),
    canCategorise: account.canEdit && canCategorise(actor, account.ownerMembershipId),
  };
}

/** The account's owner, a CS Leader or an Admin may set the forecast category; no one else. */
export function canCategorise(
  actor: Pick<Actor, "role" | "membershipId">,
  ownerMembershipId: string | null,
): boolean {
  if (actor.role === "ADMIN" || actor.role === "CS_LEADER") return true;
  return actor.role === "CSM" && ownerMembershipId === actor.membershipId;
}

export const categoryInput = z.object({
  category: z.enum(FORECAST_CATEGORIES).nullable(),
  note: z.string().trim().max(500).optional(),
});

/**
 * A human forecast category (spec §6N, D3). It never touches the computed confidence; the two are
 * shown side by side and a difference is flagged. Audited with before and after. `null` clears it.
 */
export async function setForecastCategory(actor: Actor, renewalId: string, raw: unknown) {
  const input = categoryInput.parse(raw);
  const db = scopedDb(actor);
  const renewal = await db.renewal.findUnique({
    where: { workspaceId_id: { workspaceId: actor.workspaceId, id: renewalId } },
    select: {
      id: true,
      forecastCategory: true,
      forecastNote: true,
      confidenceBand: true,
      account: { select: { id: true, name: true, ownerMembershipId: true } },
    },
  });
  if (!renewal || !(await getAccount(actor, renewal.account.id)))
    throw new RenewalError("This renewal does not exist.");
  if (!canCategorise(actor, renewal.account.ownerMembershipId))
    throw new ForbiddenError("accounts:edit");
  const next = input.category;
  await db.$tenantTransaction(async (tx) => {
    await tx.renewal.update({
      where: { workspaceId_id: { workspaceId: actor.workspaceId, id: renewalId } },
      data: {
        forecastCategory: next,
        forecastNote: next ? (input.note ?? null) : null,
        forecastSetByMembershipId: next ? actor.membershipId : null,
        forecastSetAt: next ? new Date() : null,
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "renewal.forecast_category_set",
        targetType: "Renewal",
        targetId: renewalId,
        summary: `Set the forecast category for ${renewal.account.name} to ${next ?? "none"} (computed band ${renewal.confidenceBand})`,
        before: { category: renewal.forecastCategory, note: renewal.forecastNote },
        after: { category: next, note: next ? (input.note ?? null) : null },
      },
      tx,
    );
  });
}
