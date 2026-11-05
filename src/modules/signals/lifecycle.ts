import { isDeepStrictEqual } from "node:util";
import type { Prisma, Signal } from "@prisma/client";
import { utcMidnight, type CalendarDate, type Clock } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { writeOutboxEvent } from "@/lib/jobs/outbox";
import { loadBundles, loadContext } from "@/modules/health/service";
import { onboardingFactsFor, type OnboardingPlanFacts } from "@/modules/onboarding/service";
import { loadExpansionFacts } from "./expansion-facts";
import { loadPromiseFacts } from "./promise-facts";
import { loadPeopleFacts } from "./people-facts";
import { loadTextFacts } from "./text-facts";
import { loadMeetingFacts } from "./meeting-facts";
import { syncSignalRules } from "./rule-rows";
import { RULE_BY_KEY, type RuleKey } from "./rules/catalog";
import {
  evaluateRule,
  materiallyWorse,
  type Severity,
  type SignalBundle,
  type SignalCandidate,
} from "./rules";

/**
 * Signal lifecycle (ARCHITECTURE §5.2, M3 rule 8, D-53, D-57). For a chunk of accounts as of a
 * date: run every enabled rule; upsert each candidate by dedupeKey (one live episode at most —
 * the database enforces it too); resolve live signals whose condition cleared, with the reason;
 * keep false alarms suppressed until materially worse; create an OutcomeRecord for each new
 * episode of WARN or above. Re-running with the same data changes nothing.
 */
export interface EvaluateResult {
  opened: number;
  updated: number;
  resolved: number;
  suppressed: number;
}

const LIVE = new Set(["OPEN", "ACKNOWLEDGED"]);
const json = (v: unknown) => v as Prisma.InputJsonValue;
const SEV: Record<Severity, number> = { INFO: 0, WARN: 1, CRITICAL: 2 };

export async function evaluateAndStore(
  ctx: TenantContext,
  accountIds: string[],
  asOf: CalendarDate,
  clock: Clock,
  /** M6: onboarding facts the nightly chunk already computed; loaded here when absent. */
  onboarding?: Map<string, OnboardingPlanFacts>,
): Promise<EvaluateResult> {
  const db = scopedDb(ctx);
  const ids = [...new Set(accountIds)];
  const result: EvaluateResult = { opened: 0, updated: 0, resolved: 0, suppressed: 0 };
  if (ids.length === 0) return result;
  await syncSignalRules(ctx);

  const healthCtx = await loadContext(ctx);
  const [rules, bundles, failures, existing, accounts, onboardingFacts] = await Promise.all([
    db.signalRule.findMany({ where: { enabled: true, dormantReason: null } }),
    loadBundles(db, healthCtx, asOf, ids),
    db.invoice.findMany({
      where: { accountId: { in: ids }, failureCount: { gt: 0 } },
      select: { id: true, failureCount: true },
    }),
    db.signal.findMany({
      where: { accountId: { in: ids } },
      orderBy: [{ dedupeKey: "asc" }, { episode: "desc" }],
    }),
    db.account.findMany({
      where: { id: { in: ids } },
      select: { id: true, arrMinor: true, arrCurrency: true },
    }),
    onboarding ?? onboardingFactsFor(db, ids, asOf),
  ]);
  const expansion = await loadExpansionFacts(
    db,
    asOf,
    ids,
    new Map([...bundles].flatMap(([id, b]) => (b.contract ? [[id, b.contract.id] as const] : []))),
  );
  const promises = await loadPromiseFacts(db, ids);
  const text = await loadTextFacts(db, asOf, ids, healthCtx.timeZone);
  const people = await loadPeopleFacts(db, asOf, ids, healthCtx.timeZone);
  const meetings = await loadMeetingFacts(db, ids);
  const failureCounts = Object.fromEntries(failures.map((f) => [f.id, f.failureCount]));
  const latest = new Map<string, Signal>();
  for (const s of existing) if (!latest.has(s.dedupeKey)) latest.set(s.dedupeKey, s);
  const arr = new Map(accounts.map((a) => [a.id, a]));
  const now = clock();
  const day = utcMidnight(asOf);

  for (const accountId of ids) {
    const base = bundles.get(accountId);
    if (!base) continue;
    const bundle: SignalBundle = {
      ...base,
      invoiceFailureCounts: failureCounts,
      meetings: meetings ? (meetings.get(accountId) ?? []) : null,
      onboarding: onboardingFacts.get(accountId) ?? null,
      expansion: expansion.get(accountId) ?? null,
      promises: promises.get(accountId) ?? [],
      text: text.get(accountId) ?? [],
      people: people.get(accountId) ?? { titleChanges: [] },
    };
    const seen = new Set<string>();
    const evaluatedRules = new Set<string>();

    for (const rule of rules) {
      const meta = RULE_BY_KEY.get(rule.ruleKey as RuleKey);
      if (!meta || meta.category === "OUTSIDE") continue; // outside events are entered, not evaluated
      evaluatedRules.add(rule.ruleKey);
      const candidates = evaluateRule(rule.ruleKey as RuleKey, bundle, rule.params, {
        isOpen: (k) => LIVE.has(latest.get(k)?.status ?? ""),
      });
      for (const c of candidates) {
        seen.add(c.dedupeKey);
        const prev = latest.get(c.dedupeKey);
        if (prev && LIVE.has(prev.status)) {
          if (await updateLive(db, prev, c, day, now)) result.updated++;
          continue;
        }
        if (
          prev?.status === "FALSE_ALARM" &&
          !materiallyWorse(
            rule.ruleKey as RuleKey,
            {
              severity: prev.severity,
              values: (prev.falseAlarmValues ?? prev.values) as Record<string, unknown>,
            },
            { severity: c.severity, values: c.values },
            rule.params,
          )
        ) {
          result.suppressed++;
          continue;
        }
        const created = await open(
          db,
          ctx.workspaceId,
          accountId,
          rule,
          meta.category,
          meta.polarity,
          c,
          {
            episode: (prev?.episode ?? 0) + 1,
            day,
            now,
            arr: arr.get(accountId) ?? null,
          },
        );
        latest.set(c.dedupeKey, created);
        result.opened++;
      }
    }

    // Live signals of rules that ran for this account and no longer produce their key: resolved.
    for (const s of latest.values()) {
      if (s.accountId !== accountId || !LIVE.has(s.status) || seen.has(s.dedupeKey)) continue;
      if (!evaluatedRules.has(s.ruleKey)) continue;
      const label = RULE_BY_KEY.get(s.ruleKey as RuleKey)?.label ?? s.ruleKey;
      await db.$tenantTransaction(async (tx) => {
        await tx.signal.update({
          where: { id: s.id },
          data: {
            status: "RESOLVED",
            resolvedAt: now,
            resolvedReason: `${label}: no longer detected on ${asOf}; the condition cleared.`,
          },
        });
        await writeOutboxEvent(tx, {
          workspaceId: ctx.workspaceId,
          type: "signal.resolved",
          payload: { signalId: s.id, accountId, ruleKey: s.ruleKey, asOf },
        });
      });
      latest.set(s.dedupeKey, { ...s, status: "RESOLVED" });
      result.resolved++;
    }
  }
  return result;
}

/** Refresh a live episode; returns false when nothing changed (idempotent re-run). */
async function updateLive(
  db: ReturnType<typeof scopedDb>,
  prev: Signal,
  c: SignalCandidate,
  day: Date,
  now: Date,
) {
  const same =
    prev.severity === c.severity &&
    prev.title === c.title &&
    prev.explanation === c.explanation &&
    prev.lastSeenAt.getTime() === day.getTime() &&
    // jsonb reorders keys, so compare structurally.
    isDeepStrictEqual(prev.values, JSON.parse(JSON.stringify(c.values)));
  if (same) return false;
  await db.$tenantTransaction(async (tx) => {
    await tx.signal.update({
      where: { id: prev.id },
      data: {
        severity: c.severity,
        title: c.title,
        explanation: c.explanation,
        evidence: json(c.evidence),
        values: json(c.values),
        lastSeenAt: day > prev.lastSeenAt ? day : prev.lastSeenAt,
      },
    });
    // An INFO episode that becomes WARN or above is flagged now: it gets its outcome record.
    if (SEV[c.severity] >= SEV.WARN && SEV[prev.severity] < SEV.WARN) {
      const account = await tx.account.findUniqueOrThrow({
        where: { id: prev.accountId },
        select: { arrMinor: true, arrCurrency: true },
      });
      await tx.outcomeRecord.upsert({
        where: { workspaceId_signalId: { workspaceId: prev.workspaceId, signalId: prev.id } },
        create: outcome(prev.workspaceId, prev.accountId, prev.id, prev.polarity, now, account),
        update: {},
      });
    }
  });
  return true;
}

function outcome(
  workspaceId: string,
  accountId: string,
  signalId: string,
  polarity: "RISK" | "OPPORTUNITY",
  flaggedAt: Date,
  arr: { arrMinor: bigint | null; arrCurrency: string | null } | null,
): Prisma.OutcomeRecordUncheckedCreateInput {
  return {
    workspaceId,
    accountId,
    signalId,
    flagType: polarity,
    flaggedAt,
    // ARR at the flag; unknown ARR stays empty, never 0 (Rule 4).
    arrAtFlagMinor: arr?.arrMinor ?? null,
    arrCurrency: arr?.arrMinor !== null && arr?.arrMinor !== undefined ? arr.arrCurrency : null,
  };
}

async function open(
  db: ReturnType<typeof scopedDb>,
  workspaceId: string,
  accountId: string,
  rule: { ruleKey: string; version: number; params: Prisma.JsonValue },
  category: "USAGE" | "PEOPLE" | "SUPPORT" | "CALLS_EMAIL" | "MONEY" | "PROMISES" | "OUTSIDE",
  polarity: "RISK" | "OPPORTUNITY",
  c: SignalCandidate,
  o: {
    episode: number;
    day: Date;
    now: Date;
    arr: { arrMinor: bigint | null; arrCurrency: string | null } | null;
  },
): Promise<Signal> {
  return db.$tenantTransaction(async (tx) => {
    const s = await tx.signal.create({
      data: {
        workspaceId,
        accountId,
        ruleKey: rule.ruleKey,
        ruleVersion: rule.version,
        category,
        polarity,
        severity: c.severity,
        status: "OPEN",
        title: c.title,
        explanation: c.explanation,
        evidence: json(c.evidence),
        values: json(c.values),
        params: json(rule.params ?? {}),
        dedupeKey: c.dedupeKey,
        episode: o.episode,
        firstSeenAt: o.day,
        lastSeenAt: o.day,
        origin: "SYSTEM",
      },
    });
    if (SEV[c.severity] >= SEV.WARN)
      await tx.outcomeRecord.create({
        data: outcome(workspaceId, accountId, s.id, polarity, o.now, o.arr),
      });
    await writeOutboxEvent(tx, {
      workspaceId,
      type: "signal.opened",
      payload: {
        signalId: s.id,
        accountId,
        ruleKey: rule.ruleKey,
        severity: c.severity,
        episode: o.episode,
      },
    });
    return s;
  });
}
