import { z } from "zod";
import { requirePermission } from "@/lib/auth/permissions";
import { addDays, businessClock, calendarDateOf, todayIn, type Clock } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { loadContext } from "@/modules/health/service";
import { billingForecast } from "./billingForecast";
import { coverage, DEFAULT_COVERAGE_DAYS } from "./coverage";
import { moneyAtRisk } from "./moneyAtRisk";
import { teamLoad } from "./teamLoad";
import { waterfall } from "./waterfall";

export const revenueQuery = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    coverageDays: z.coerce.number().int().min(1).max(365).default(DEFAULT_COVERAGE_DAYS),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: "The start must not be after the end.",
  });

/**
 * /revenue (spec §6N): everything here is money, so the whole view needs revenue access
 * (`revenue:view`, per membership, any role). Without it the service refuses and the route is a
 * 404; no figure is computed for a member who may not see it. A fixed number of queries.
 */
export async function getRevenueView(
  actor: Actor,
  raw: unknown = {},
  clock: Clock = businessClock,
) {
  requirePermission(actor, "revenue:view");
  const q = revenueQuery.parse(raw);
  const ctx = await loadContext(actor);
  const asOf = todayIn(ctx.timeZone, clock);
  const to = q.to ?? asOf;
  const from = q.from ?? addDays(to, -90);
  const db = scopedDb(actor);
  const [events, renewals, accounts, subscriptions, tasks, members] = await Promise.all([
    db.revenueEvent.findMany({
      select: {
        id: true,
        accountId: true,
        type: true,
        deltaArrMinor: true,
        currency: true,
        effectiveDate: true,
      },
    }),
    db.renewal.findMany({
      where: { stage: { in: ["UPCOMING", "IN_PROGRESS"] } },
      select: {
        id: true,
        accountId: true,
        renewalDate: true,
        arrAtRiskMinor: true,
        currency: true,
        confidenceBand: true,
        account: { select: { currentHealth: { select: { riskLevel: true } } } },
      },
    }),
    db.account.findMany({
      where: { archivedAt: null, churnedAt: null },
      select: {
        id: true,
        name: true,
        ownerMembershipId: true,
        arrMinor: true,
        arrCurrency: true,
        lastTouchAt: true,
      },
    }),
    db.subscription.findMany({
      select: {
        id: true,
        accountId: true,
        interval: true,
        amountMinor: true,
        currency: true,
        status: true,
        currentPeriodEnd: true,
      },
    }),
    db.task.groupBy({
      by: ["ownerMembershipId"],
      where: { status: "OPEN" },
      _count: { _all: true },
    }),
    db.membership.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, user: { select: { name: true, email: true } } },
    }),
  ]);
  const wf = waterfall(
    events.map((e) => ({ ...e, effectiveDate: calendarDateOf(e.effectiveDate) })),
    { from, to },
    ctx.baseCurrency,
  );
  const riskRows = renewals.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    renewalDate: calendarDateOf(r.renewalDate),
    arrMinor: r.arrAtRiskMinor,
    currency: r.currency,
    band: r.confidenceBand,
    accountRisk: r.account.currentHealth?.riskLevel ?? null,
  }));
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  return {
    asOf,
    baseCurrency: ctx.baseCurrency,
    waterfall: wf,
    billing: billingForecast(subscriptions, asOf, 6),
    atRisk: [30, 90].map((d) => moneyAtRisk(riskRows, asOf, d, ctx.baseCurrency)),
    coverage: coverage(accounts, asOf, q.coverageDays),
    load: teamLoad(
      accounts.map((a) => ({
        id: a.id,
        ownerMembershipId: a.ownerMembershipId,
        arrMinor: a.arrMinor,
        currency: a.arrCurrency,
      })),
      new Map(tasks.map((t) => [t.ownerMembershipId, t._count._all])),
      ctx.baseCurrency,
    ),
    members: new Map(members.map((m) => [m.id, m.user.name ?? m.user.email])),
    accountNames: names,
  };
}
