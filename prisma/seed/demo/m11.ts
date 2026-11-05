import type { Prisma } from "@prisma/client";
import type { ScopedDb } from "@/lib/db/scoped";
import {
  evaluateLongCheckpoints,
  evaluateRevenueCheckpoints,
  evaluateSevenDayCheckpoints,
} from "@/modules/outcomes/service";
import { daysAgo } from "./dates";
import { ids, seedId } from "./ids";
import { ROSTER, type AccountSpec } from "./roster";

/**
 * Seed M11 (D-166 / founder D9): the outcome ledger's HISTORY as raw inputs only — historical flags
 * (resolved signals + their OutcomeRecords with the flag facts) and the actions taken on them
 * (done tasks). Every checkpoint value (d7/d30/d90, revenue status, alarm class) is computed by the
 * real checkpoint code at the end, against the seed's existing contract-derived revenue events.
 * Nothing here writes an outcome. History signals use their own `history:` dedupe keys so the live
 * pipeline never treats them as episodes of today's signals. Idempotent (fixed ids, upserts).
 *
 * Which accounts (SEED_DATA §8):
 * - churned (9 of 12): flagged 60 days before the churn by the pattern's rule; the 3 silent churns
 *   were never flagged (that miss is part of the honest record). Even-indexed flags were acted on.
 * - renewed with a contraction: flagged for unused seats 40 days before the renewal; acted on.
 * - renewed with an expansion: an opportunity flag (seats near limit) 45 days before; 4 acted on.
 * - the two false-alarm cases: the seasonal dip (usage drop, not acted on) and the migration support
 *   spike (marked FALSE_ALARM by its CSM, as the CSM Pulse in seed v2 says).
 */
interface HistoryFlag {
  key: string;
  ruleKey: string;
  category: "USAGE" | "PEOPLE" | "MONEY" | "SUPPORT" | "CALLS_EMAIL";
  polarity: "RISK" | "OPPORTUNITY";
  title: string;
  flaggedDaysAgo: number;
  acted: boolean;
  falseAlarm?: string;
}

const CHURN_RULE: Record<string, Omit<HistoryFlag, "key" | "flaggedDaysAgo" | "acted">> = {
  "usage drop": {
    ruleKey: "usage_drop_vs_normal",
    category: "USAGE",
    polarity: "RISK",
    title: "Usage dropped below normal",
  },
  "champion left": {
    ruleKey: "champion_role_change",
    category: "PEOPLE",
    polarity: "RISK",
    title: "Champion's role changed",
  },
  "payment failures": {
    ruleKey: "payment_failed",
    category: "MONEY",
    polarity: "RISK",
    title: "Payment failed",
  },
  "support escalation": {
    ruleKey: "ticket_escalated",
    category: "SUPPORT",
    polarity: "RISK",
    title: "Ticket escalated",
  },
};

export function historyFlags(roster: readonly AccountSpec[] = ROSTER): HistoryFlag[] {
  const flags: HistoryFlag[] = [];
  roster
    .filter((a) => a.churnedDaysAgo !== undefined)
    .forEach((a, i) => {
      const pattern = /churned \((.+)\)/.exec(a.story ?? "")?.[1] ?? "";
      const rule = CHURN_RULE[pattern];
      if (!rule) return; // silent churn: never flagged
      flags.push({
        key: a.key,
        ...rule,
        flaggedDaysAgo: a.churnedDaysAgo! + 60,
        acted: i % 2 === 0,
      });
    });
  const renewed = roster.filter((a) => a.renewedDaysAgo !== undefined);
  renewed.forEach((a, i) => {
    const r = a.renewedDaysAgo!;
    if (a.story?.includes("temporary dip"))
      flags.push({
        key: a.key,
        ruleKey: "usage_drop_vs_normal",
        category: "USAGE",
        polarity: "RISK",
        title: "Usage dropped below normal",
        flaggedDaysAgo: r + 30,
        acted: false,
      });
    else if (a.story?.includes("migration support spike"))
      flags.push({
        key: a.key,
        ruleKey: "ticket_open_too_long",
        category: "SUPPORT",
        polarity: "RISK",
        title: "Ticket open too long",
        flaggedDaysAgo: r + 30,
        acted: false,
        falseAlarm: "Spike was one migration, resolved",
      });
    else if (i < 6)
      flags.push({
        key: a.key,
        ruleKey: "seats_near_limit",
        category: "USAGE",
        polarity: "OPPORTUNITY",
        title: "Seats near the purchased limit",
        flaggedDaysAgo: r + 45,
        acted: i % 3 !== 2,
      });
    else if (i < 9)
      flags.push({
        key: a.key,
        ruleKey: "seats_unused",
        category: "USAGE",
        polarity: "RISK",
        title: "Purchased seats unused",
        flaggedDaysAgo: r + 40,
        acted: true,
      });
  });
  return flags;
}

export async function seedM11(db: ScopedDb, workspaceId: string, timezone: string): Promise<void> {
  const rules = new Map(
    (await db.signalRule.findMany({ select: { ruleKey: true, version: true } })).map((r) => [
      r.ruleKey,
      r.version,
    ]),
  );
  const byKey = new Map(ROSTER.map((a) => [a.key, a]));
  for (const f of historyFlags()) {
    const a = byKey.get(f.key)!;
    const accountId = ids.account(f.key);
    const signalId = seedId(`history:signal:${f.key}:${f.ruleKey}`);
    const flaggedAt = daysAgo(f.flaggedDaysAgo);
    const signal = {
      accountId,
      ruleKey: f.ruleKey,
      ruleVersion: rules.get(f.ruleKey) ?? 1,
      category: f.category,
      severity: "WARN" as const,
      polarity: f.polarity,
      title: f.title,
      explanation: `${f.title} (seeded history, SEED_DATA §8).`,
      evidence: [{ sourceType: "Account", sourceId: accountId }],
      values: {},
      params: {},
      dedupeKey: `history:${f.key}:${f.ruleKey}`,
      firstSeenAt: flaggedAt,
      lastSeenAt: flaggedAt,
      status: f.falseAlarm ? ("FALSE_ALARM" as const) : ("RESOLVED" as const),
      resolvedAt: f.falseAlarm ? null : daysAgo(f.flaggedDaysAgo - 45),
      ...(f.falseAlarm
        ? {
            falseAlarmReason: f.falseAlarm,
            markedFalseAt: daysAgo(f.flaggedDaysAgo - 3),
            markedFalseById: ids.membership(a.owner === "leo" ? "leo" : "aisha"),
          }
        : {}),
    };
    await db.signal.upsert({
      where: { id: signalId },
      create: { id: signalId, workspaceId, ...signal },
      update: signal,
    });

    const refs: Array<{ type: "Task"; id: string }> = [];
    const actedAt = daysAgo(f.flaggedDaysAgo - 2);
    if (f.acted) {
      const taskId = seedId(`history:task:${f.key}:${f.ruleKey}`);
      const owner = ids.membership(a.owner === "leo" ? "leo" : "aisha");
      const task = {
        accountId,
        signalId,
        title: `Follow up: ${f.title.toLowerCase()} at ${a.name}`,
        ownerMembershipId: owner,
        createdByMembershipId: owner,
        status: "DONE" as const,
        completedAt: actedAt,
        source: "SEED" as const,
        createdAt: daysAgo(f.flaggedDaysAgo - 1),
      };
      await db.task.upsert({
        where: { id: taskId },
        create: { id: taskId, workspaceId, ...task },
        update: task,
      });
      refs.push({ type: "Task", id: taskId });
    }

    const outcomeId = seedId(`history:outcome:${f.key}:${f.ruleKey}`);
    const arr = a.arrUsd === null ? null : BigInt(a.arrUsd * 100);
    const flag = {
      accountId,
      signalId,
      flagType: f.polarity,
      flaggedAt,
      arrAtFlagMinor: arr,
      arrCurrency: arr === null ? null : "USD",
    };
    // Flag facts and action links only; the checkpoint columns are never written here.
    await db.outcomeRecord.upsert({
      where: { id: outcomeId },
      create: {
        id: outcomeId,
        workspaceId,
        ...flag,
        actionTaken: f.acted ? "ACTED" : "PENDING",
        actionRefs: refs as unknown as Prisma.InputJsonValue,
        firstActionAt: f.acted ? actedAt : null,
      },
      update: flag,
    });
  }

  // The M11 demo/e2e publishes Renewal Risk through the Plays service; the seed returns it to
  // DRAFT (as seed M10 does for Promise Late after the M9 e2e).
  await db.play.updateMany({
    where: { key: "renewal-risk", status: "PUBLISHED" },
    data: { status: "DRAFT" },
  });

  // The real checkpoint code computes every result (idempotent: stored checkpoints are skipped).
  const clock = () => daysAgo(0);
  await evaluateSevenDayCheckpoints({ workspaceId }, clock);
  await evaluateRevenueCheckpoints({ workspaceId }, clock);
  await evaluateLongCheckpoints({ workspaceId, timezone }, clock);
}
