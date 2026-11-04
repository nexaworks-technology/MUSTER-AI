import { writeAudit } from "@/lib/audit";
import { utcMidnight, type CalendarDate } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { estimateSeatsOverLimit, type SeatsOverEstimate } from "./estimate";

/**
 * `expansion.sync` (M7 B2), a stage of the nightly score chunk after `renewals.sync`. For each
 * account in the chunk with a live expansion signal it keeps ONE open opportunity: it names the
 * signals that raised it, and carries a deterministic estimate (money only from the account's own
 * subscription, never from a model). Everything a person set (owner, next step, status) is left
 * alone. A closed or dismissed opportunity is not re-opened by the same signal episodes; a new
 * episode is a new opportunity. A fixed number of reads per chunk.
 */
export const EXPANSION_RULES = [
  "seats_near_limit",
  "new_team_using",
  "fast_growth",
  "goal_stated_expansion",
] as const;

export interface ExpansionSyncCounts {
  created: number;
  updated: number;
  unchanged: number;
}

const LIVE = ["OPEN", "ACKNOWLEDGED"] as const;
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

export async function syncExpansion(
  ctx: TenantContext,
  accountIds: string[],
  asOf: CalendarDate,
): Promise<ExpansionSyncCounts> {
  const counts: ExpansionSyncCounts = { created: 0, updated: 0, unchanged: 0 };
  if (accountIds.length === 0) return counts;
  const db = scopedDb(ctx);
  const signals = await db.signal.findMany({
    where: {
      accountId: { in: accountIds },
      ruleKey: { in: [...EXPANSION_RULES] },
      polarity: "OPPORTUNITY",
      status: { in: [...LIVE] },
    },
    select: { id: true, accountId: true, ruleKey: true, dedupeKey: true, values: true },
    orderBy: { id: "asc" },
  });
  if (signals.length === 0) return counts;
  const ids = [...new Set(signals.map((s) => s.accountId))];
  const day = utcMidnight(asOf);
  const [contracts, subscriptions, opportunities, accounts] = await Promise.all([
    db.contract.findMany({
      where: { accountId: { in: ids }, status: "ACTIVE", startDate: { lte: day } },
      select: { id: true, accountId: true, startDate: true },
    }),
    db.subscription.findMany({
      where: { accountId: { in: ids } },
      select: {
        id: true,
        accountId: true,
        contractId: true,
        status: true,
        interval: true,
        amountMinor: true,
        currency: true,
        quantity: true,
      },
    }),
    db.expansionOpportunity.findMany({
      where: { accountId: { in: ids } },
      orderBy: { createdAt: "asc" },
    }),
    db.account.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, ownerMembershipId: true },
    }),
  ]);

  for (const a of accounts) {
    const live = signals.filter((s) => s.accountId === a.id);
    const liveIds = live.map((s) => s.id);
    const contract = contracts
      .filter((c) => c.accountId === a.id)
      .sort((x, y) => y.startDate.getTime() - x.startDate.getTime())[0];
    // Seats, from the very signal that fired (its figures are the records' figures as of then).
    const seats = live.find(
      (s) => s.ruleKey === "seats_near_limit" && !s.dedupeKey.endsWith(":credits"),
    );
    const estimate: SeatsOverEstimate | null = seats
      ? estimateSeatsOverLimit({
          seatsPurchased: num((seats.values as Record<string, unknown>).seats),
          seatsUsed: num((seats.values as Record<string, unknown>).used),
          contractId: contract?.id ?? null,
          subscriptions: subscriptions
            .filter((s) => s.accountId === a.id)
            .map((s) => ({
              id: s.id,
              status: s.status,
              interval: s.interval,
              amountMinor: s.amountMinor,
              currency: s.currency,
              quantity: s.quantity,
              contractId: s.contractId,
            })),
        })
      : null;
    const mine = opportunities.filter((o) => o.accountId === a.id);
    const open = mine.find((o) => o.status === "OPEN" || o.status === "IN_PROGRESS");
    const data = {
      signalIds: liveIds,
      estimateMinor: estimate?.estimateMinor ?? null,
      currency: estimate?.currency ?? null,
      estimateMethod: estimate ? ("SEATS_OVER_LIMIT" as const) : null,
    };
    if (open) {
      const same =
        open.signalIds.join() === data.signalIds.join() &&
        open.estimateMinor === data.estimateMinor &&
        open.currency === data.currency &&
        open.estimateMethod === data.estimateMethod;
      if (same) {
        counts.unchanged++;
        continue;
      }
      await db.$tenantTransaction(async (tx) => {
        await tx.expansionOpportunity.update({ where: { id: open.id }, data });
        await writeAudit(
          {
            workspaceId: ctx.workspaceId,
            actorType: "SYSTEM",
            action: "expansion.opportunity_refreshed",
            targetType: "ExpansionOpportunity",
            targetId: open.id,
            summary: `Refreshed the expansion opportunity for ${a.name} on ${asOf} from its live signals`,
          },
          tx,
        );
      });
      counts.updated++;
      continue;
    }
    // The same episodes already closed or dismissed by a person: do not bring it back.
    if (mine.some((o) => liveIds.every((id) => o.signalIds.includes(id)))) {
      counts.unchanged++;
      continue;
    }
    await db.$tenantTransaction(async (tx) => {
      const created = await tx.expansionOpportunity.create({
        data: {
          workspaceId: ctx.workspaceId,
          accountId: a.id,
          ownerMembershipId: a.ownerMembershipId,
          ...data,
        },
      });
      await writeAudit(
        {
          workspaceId: ctx.workspaceId,
          actorType: "SYSTEM",
          action: "expansion.opportunity_created",
          targetType: "ExpansionOpportunity",
          targetId: created.id,
          summary: `Opened an expansion opportunity for ${a.name} on ${asOf} from ${live.length} live signal${live.length === 1 ? "" : "s"}`,
        },
        tx,
      );
    });
    counts.created++;
  }
  return counts;
}
