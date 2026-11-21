import type { Prisma } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import { addDays, calendarDateOf, utcMidnight, type CalendarDate } from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { RENEWAL_GRACE_DAYS } from "@/modules/billing/service";
import { getActiveModel, modelConfigOf, scoreAsOf } from "@/modules/health/service";
import { getSettingsData } from "@/modules/settings/service";
import { RESTATES_OTHER_FACTORS } from "@/modules/signals/service";
import { confidence, type Factor } from "./confidence";
import { inputFromBundle } from "./inputs";

/**
 * `renewals.sync` (M7 A4), a stage of the nightly score chunk (after health, so it reads tonight's
 * snapshot). For the chunk's accounts it:
 *
 * 1. creates or refreshes a `Renewal` row for every ACTIVE contract whose renewal date falls in the
 *    next `horizonDays`, and keeps refreshing an open row after its date has passed (overdue):
 *    deterministic confidence with its reasons and sources. A contract with no
 *    renewal date gets no row and no guess; the M2 missing-data helper already asks for the date;
 * 2. detects outcomes from contract records only: a later contract that starts within the renewal
 *    grace of the old one's end is RENEWED; an ENDED or CANCELLED contract with no successor is
 *    CHURNED. The outcome is a new append-only `RenewalOutcome` row carrying the forecast as it
 *    stood (the Renewal's stored likelihood, band, category and reasons before tonight's run).
 *
 * It never opens signals (the M3 renewal-window rules own that, M7 k) and writes no health.
 * Set-based: a fixed number of reads per chunk whatever its size; a chunk with no renewals and no
 * open renewal rows stops after two reads.
 */
export interface SyncCounts {
  created: number;
  updated: number;
  unchanged: number;
  renewed: number;
  churned: number;
}

const DAY = 86_400_000;
const day = (d: Date) => calendarDateOf(d);
/** jsonb does not keep key order: compare JSON with keys sorted. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

export async function syncRenewals(
  ctx: TenantContext,
  accountIds: string[],
  asOf: CalendarDate,
): Promise<SyncCounts> {
  const counts: SyncCounts = { created: 0, updated: 0, unchanged: 0, renewed: 0, churned: 0 };
  if (accountIds.length === 0) return counts;
  const db = scopedDb(ctx);
  const [contracts, existing] = await Promise.all([
    db.contract.findMany({ where: { accountId: { in: accountIds } } }),
    db.renewal.findMany({ where: { accountId: { in: accountIds } } }),
  ]);
  const settings = (await getSettingsData(ctx.workspaceId)).renewals;
  const horizon = addDays(asOf, settings.horizonDays);
  const today = utcMidnight(asOf);

  // ── 1. Outcomes, from contract records, for renewals still open ─────────────────────────────
  const byAccount = new Map<string, typeof contracts>();
  for (const c of contracts) byAccount.set(c.accountId, [...(byAccount.get(c.accountId) ?? []), c]);
  const open = existing.filter((r) => r.stage === "UPCOMING" || r.stage === "IN_PROGRESS");
  for (const r of open) {
    const mine = byAccount.get(r.accountId) ?? [];
    const old = mine.find((c) => c.id === r.contractId);
    if (!old) continue;
    const ends = old.endDate ?? old.renewalDate ?? r.renewalDate;
    const successor = mine
      .filter(
        (c) =>
          c.id !== old.id &&
          c.status !== "CANCELLED" &&
          c.startDate > old.startDate &&
          c.startDate.getTime() >= ends.getTime() - RENEWAL_GRACE_DAYS * DAY &&
          c.startDate <= today,
      )
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())[0];
    const lost = !successor && old.status !== "ACTIVE" && ends <= today ? { on: ends } : null;
    if (!successor && !lost) continue;
    const result = successor ? ("RENEWED" as const) : ("CHURNED" as const);
    await db.$tenantTransaction(async (tx) => {
      const outcome = await tx.renewalOutcome.create({
        data: {
          workspaceId: ctx.workspaceId,
          accountId: r.accountId,
          renewalId: r.id,
          result,
          occurredOn: successor ? successor.startDate : lost!.on,
          outcomeArrMinor: successor ? successor.valueMinor : 0n,
          currency: successor ? successor.currency : old.currency,
          detectedVia: "CONTRACT_RECORDS",
          forecastConfidence: r.confidence,
          forecastBand: r.confidenceBand,
          forecastCategory: r.forecastCategory,
          forecastAsOf: r.confidenceAsOf,
          forecastArrAtRiskMinor: r.arrAtRiskMinor,
          forecastReasons: r.confidenceReasons as Prisma.InputJsonValue,
        },
      });
      await tx.renewal.update({
        where: { id: r.id },
        data: { stage: result === "RENEWED" ? "RENEWED" : "CHURNED" },
      });
      await writeAudit(
        {
          workspaceId: ctx.workspaceId,
          actorType: "SYSTEM",
          action: `renewal.${result.toLowerCase()}`,
          targetType: "Renewal",
          targetId: r.id,
          summary: `Renewal ${result === "RENEWED" ? "renewed" : "churned"} on ${day(outcome.occurredOn)}, detected from contract records; the forecast then was ${r.confidence} (${r.confidenceBand.toLowerCase()})`,
        },
        tx,
      );
    });
    counts[result === "RENEWED" ? "renewed" : "churned"]++;
    r.stage = result === "RENEWED" ? "RENEWED" : "CHURNED"; // not recomputed below
  }

  // ── 2. The radar: ACTIVE contracts renewing inside the horizon, and open renewals whose date
  // has passed with no outcome yet (overdue: still scored every night, DEMO FAIL 29). A contract
  // whose date passed before it was ever tracked gets no row: that needs a person, not a guess.
  const stillOpen = (c: (typeof contracts)[number]) =>
    existing.some(
      (r) =>
        r.contractId === c.id &&
        day(r.renewalDate) === day(c.renewalDate!) &&
        (r.stage === "UPCOMING" || r.stage === "IN_PROGRESS"),
    );
  const radar = contracts.filter(
    (c) =>
      c.status === "ACTIVE" &&
      c.renewalDate !== null &&
      day(c.renewalDate) <= horizon &&
      (c.renewalDate >= today || stillOpen(c)),
  );
  if (radar.length === 0) return counts;
  const ids = [...new Set(radar.map((c) => c.accountId))];
  const model = await getActiveModel(ctx);
  const cfgModel = { id: model.id, config: modelConfigOf(model) };
  const [scored, prior, tonight, signals] = await Promise.all([
    scoreAsOf(ctx, ids, asOf, cfgModel),
    db.healthScoreSnapshot.findMany({
      where: {
        accountId: { in: ids },
        healthModelId: model.id,
        isBacktest: false,
        asOf: {
          lte: utcMidnight(addDays(asOf, -30)),
          gte: utcMidnight(addDays(asOf, -45)),
        },
      },
      orderBy: [{ accountId: "asc" }, { asOf: "desc" }],
      distinct: ["accountId"],
      select: { accountId: true, overall: true },
    }),
    db.healthScoreSnapshot.findMany({
      where: { accountId: { in: ids }, healthModelId: model.id, isBacktest: false, asOf: today },
      select: { id: true, accountId: true },
    }),
    db.signal.findMany({
      where: {
        accountId: { in: ids },
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        polarity: "RISK",
        severity: { in: ["WARN", "CRITICAL"] },
        category: { not: "OUTSIDE" },
        ruleKey: { notIn: [...RESTATES_OTHER_FACTORS] },
      },
      select: { id: true, accountId: true, ruleKey: true, severity: true, title: true },
      orderBy: { id: "asc" },
    }),
  ]);
  const priorOverall = new Map(prior.map((p) => [p.accountId, Number(p.overall)]));
  const snapshotId = new Map(tonight.map((t) => [t.accountId, t.id]));
  const cfg = settings.confidence;

  for (const c of radar) {
    const s = scored.get(c.accountId);
    if (!s) continue;
    const row = existing.find(
      (r) => r.contractId === c.id && day(r.renewalDate) === day(c.renewalDate!),
    );
    if (row && row.stage !== "UPCOMING" && row.stage !== "IN_PROGRESS") continue;
    const renewalDate = day(c.renewalDate!);
    const noticeDeadline =
      c.noticePeriodDays !== null ? addDays(renewalDate, -c.noticePeriodDays) : null;
    const sid = snapshotId.get(c.accountId);
    const before = priorOverall.get(c.accountId);
    const result = confidence(
      inputFromBundle({
        bundle: s.bundle,
        renewal: { contractId: c.id, renewalDate, noticeDeadline },
        health: {
          band: s.score.riskLevel,
          overall: s.score.overall,
          sources: [
            sid
              ? { sourceType: "HealthScoreSnapshot", sourceId: sid }
              : { sourceType: "Account", sourceId: c.accountId },
          ],
        },
        trend30: s.score.overall !== null && before !== undefined ? s.score.overall - before : null,
        signals: signals
          .filter((x) => x.accountId === c.accountId)
          .map((x) => ({
            key: x.ruleKey,
            severity: x.severity as "WARN" | "CRITICAL",
            title: x.title,
            sources: [{ sourceType: "Signal", sourceId: x.id }],
          })),
        plan: (() => {
          const exists = Array.isArray(row?.planSteps) && (row!.planSteps as unknown[]).length > 0;
          // The plan's own record when there is one; otherwise the contract it is missing for.
          return {
            exists,
            sources: [
              exists
                ? { sourceType: "Renewal", sourceId: row!.id }
                : { sourceType: "Contract", sourceId: c.id },
            ],
          };
        })(),
        cfg,
      }),
      cfg,
    );
    const data = {
      noticeDeadline: noticeDeadline ? utcMidnight(noticeDeadline) : null,
      arrAtRiskMinor: c.valueMinor,
      currency: c.valueMinor !== null ? c.currency : null,
      confidence: result.confidence,
      confidenceBand: result.band,
      confidenceReasons: json(result.factors satisfies Factor[]),
      confidenceAsOf: today,
    };
    if (!row) {
      await db.renewal.create({
        data: {
          workspaceId: ctx.workspaceId,
          accountId: c.accountId,
          contractId: c.id,
          renewalDate: c.renewalDate!,
          ...data,
        },
      });
      counts.created++;
      continue;
    }
    const same =
      row.confidence === data.confidence &&
      row.confidenceBand === data.confidenceBand &&
      row.arrAtRiskMinor === data.arrAtRiskMinor &&
      row.noticeDeadline?.getTime() === data.noticeDeadline?.getTime() &&
      canonical(row.confidenceReasons) === canonical(data.confidenceReasons) &&
      row.confidenceAsOf.getTime() === today.getTime();
    if (same) {
      counts.unchanged++;
      continue;
    }
    await db.renewal.update({ where: { id: row.id }, data });
    counts.updated++;
  }
  return counts;
}
