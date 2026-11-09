import { createHash } from "node:crypto";
import type { Prisma, ReportTrigger } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { businessClock, calendarDateOf, todayIn, utcMidnight, type Clock } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { bookWhere, type Actor } from "@/modules/accounts/service";
import { canSeeMoney } from "@/modules/billing/service";
import { loadContext } from "@/modules/health/service";
import { segmentWhere } from "@/modules/segments/service";
import { computeReport, type Scope, type ScopeAccount } from "./data";
import { qs } from "./figures";
import {
  normalizeFilters,
  reportFilters,
  reportKeySchema,
  resolvePeriod,
  type NormalizedFilters,
} from "./schemas";
import {
  REPORT_KEYS,
  REPORT_TITLES,
  type Figure,
  type ReportContent,
  type ReportData,
  type ReportKey,
} from "./types";

/**
 * Pre-made reports (M11 S6, spec §5 Reports). A report is a stored, dated artefact: its figures
 * come from the same computed sources the screens use, are written once into an immutable
 * ReportSnapshot, and are shown with the records behind each one. What the viewer may see is
 * decided at READ time: money is replaced for a viewer without revenue access, so a stored
 * snapshot never leaks it. The viewer's book scope is part of the snapshot's identity, never a
 * client filter.
 */
export class ReportFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportFilterError";
  }
}

export interface StoredReport {
  id: string;
  reportKey: ReportKey;
  filters: NormalizedFilters;
  generatedAt: Date;
  trigger: ReportTrigger;
  generatedByMembershipId: string | null;
  data: ReportData;
}

type Row = Prisma.ReportSnapshotGetPayload<object>;

/**
 * The snapshot's identity: normalized filters plus the book it was computed for. A leader's
 * whole-workspace snapshot is shared by everyone with that scope; an OWN/TEAM book is per member.
 */
export function filtersHash(filters: NormalizedFilters, actor: Actor, scope: string): string {
  const book = scope === "ALL" ? "ALL" : `${scope}:${actor.membershipId}`;
  return createHash("sha256").update(JSON.stringify({ filters, book })).digest("hex");
}

/** Money out, for a viewer without revenue access: the value and currency are removed. */
export function redactReport(actor: Actor, data: ReportData): ReportData {
  if (canSeeMoney(actor)) return data;
  const hide = (f: Figure): Figure =>
    f.unit === "money"
      ? {
          label: f.label,
          value: null,
          unit: "money",
          sources: { type: f.sources.type, ids: [] },
          reason: "Restricted: this figure needs revenue access.",
          restricted: true,
        }
      : f;
  return {
    ...data,
    sections: data.sections.map((s) => ({ ...s, figures: s.figures.map(hide) })),
  };
}

function toStored(actor: Actor, r: Row): StoredReport {
  return {
    id: r.id,
    reportKey: reportKeySchema.parse(r.reportKey),
    filters: r.filters as NormalizedFilters,
    generatedAt: r.generatedAt,
    trigger: r.trigger,
    generatedByMembershipId: r.generatedByMembershipId,
    data: redactReport(actor, r.data as unknown as ReportData),
  };
}

function parseFilters(raw: unknown): NormalizedFilters {
  const parsed = reportFilters.safeParse(raw ?? {});
  if (!parsed.success)
    throw new ReportFilterError(parsed.error.issues[0]?.message ?? "Those filters are not valid.");
  return normalizeFilters(parsed.data);
}

/** The accounts the viewer may report on: their book, not archived, narrowed by the filters. */
async function loadScope(
  actor: Actor,
  scopeKind: Parameters<typeof bookWhere>[1],
  filters: NormalizedFilters,
  clock: Clock,
): Promise<Scope> {
  const db = scopedDb(actor);
  const lc = await loadContext(actor);
  const today = todayIn(lc.timeZone, clock);
  const { start, end } = resolvePeriod(filters, today);
  const and: Prisma.AccountWhereInput[] = [bookWhere(actor, scopeKind), { archivedAt: null }];
  if (filters.tier) and.push({ tier: filters.tier });
  if (filters.owner === "none") and.push({ ownerMembershipId: null });
  else if (filters.owner) and.push({ ownerMembershipId: filters.owner });
  if (filters.segment) {
    const seg = await segmentWhere(actor, filters.segment);
    if (!seg) throw new ReportFilterError("That segment no longer exists.");
    and.push(seg.where);
  }
  const rows = await db.account.findMany({
    where: { AND: and },
    select: {
      id: true,
      name: true,
      tier: true,
      lifecycleStage: true,
      plan: true,
      ownerMembershipId: true,
      arrMinor: true,
      arrCurrency: true,
      currentHealth: { select: { id: true, healthModelId: true, riskLevel: true } },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const accounts: ScopeAccount[] = rows;
  return {
    actor,
    db,
    accounts,
    ids: accounts.map((a) => a.id),
    start,
    end,
    today,
    baseCurrency: lc.baseCurrency,
    timeZone: lc.timeZone,
    query: qs(["tier", filters.tier], ["owner", filters.owner], ["segment", filters.segment]),
  };
}

/**
 * Computes the report for the viewer's book and stores it as a new, dated snapshot (rows are
 * immutable: generating again adds a row). Audited. Returns it as the viewer may see it.
 */
export async function generateReport(
  actor: Actor,
  key: string,
  rawFilters: unknown,
  trigger: ReportTrigger = "MANUAL",
  clock: Clock = businessClock,
): Promise<StoredReport> {
  const grant = requirePermission(actor, "reports:view");
  const reportKey = reportKeySchema.parse(key);
  const filters = parseFilters(rawFilters);
  const scope = await loadScope(actor, grant.scope, filters, clock);
  const content: ReportContent = await computeReport(reportKey, scope);
  const data: ReportData = {
    reportKey,
    periodStart: scope.start,
    periodEnd: scope.end,
    accountsInScope: scope.ids.length,
    ...content,
  };
  const row = await scope.db.$tenantTransaction(async (tx) => {
    const created = await tx.reportSnapshot.create({
      data: {
        workspaceId: actor.workspaceId,
        reportKey,
        periodStart: utcMidnight(scope.start),
        periodEnd: utcMidnight(scope.end),
        filters: filters as Prisma.InputJsonValue,
        filtersHash: filtersHash(filters, actor, grant.scope),
        data: JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue,
        trigger,
        generatedByMembershipId: trigger === "MANUAL" ? actor.membershipId : null,
        generatedAt: clock(),
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        // A scheduled snapshot is made by the system, not by the Admin whose book scope it used.
        actorType: trigger === "SCHEDULED" ? "SYSTEM" : "USER",
        actorId: trigger === "SCHEDULED" ? null : actor.userId,
        action: "report.generated",
        targetType: "ReportSnapshot",
        targetId: created.id,
        summary: `Generated the ${REPORT_TITLES[reportKey].title} report for ${calendarDateOf(created.periodStart)} to ${calendarDateOf(created.periodEnd)} (${scope.ids.length} accounts).`,
        after: { reportKey, trigger, filters, accountsInScope: scope.ids.length },
      },
      tx,
    );
    return created;
  });
  return toStored(actor, row);
}

/** The most recent snapshot for these filters in the viewer's book, or null (nothing generated yet). */
export async function getLatestReport(
  actor: Actor,
  key: string,
  rawFilters: unknown,
): Promise<StoredReport | null> {
  const grant = requirePermission(actor, "reports:view");
  const reportKey = reportKeySchema.parse(key);
  const filters = parseFilters(rawFilters);
  const row = await scopedDb(actor).reportSnapshot.findFirst({
    where: { reportKey, filtersHash: filtersHash(filters, actor, grant.scope) },
    orderBy: [{ generatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  return row ? toStored(actor, row) : null;
}

export interface ReportListing {
  key: ReportKey;
  title: string;
  description: string;
  /** Latest snapshot with the default filters in the viewer's book. */
  latest: { id: string; generatedAt: Date } | null;
}

export async function listReports(actor: Actor): Promise<ReportListing[]> {
  const grant = requirePermission(actor, "reports:view");
  const hash = filtersHash(parseFilters({}), actor, grant.scope);
  const rows = await scopedDb(actor).reportSnapshot.findMany({
    where: { filtersHash: hash, reportKey: { in: [...REPORT_KEYS] } },
    orderBy: [{ generatedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true, reportKey: true, generatedAt: true },
  });
  return REPORT_KEYS.map((key) => {
    const latest = rows.find((r) => r.reportKey === key);
    return {
      key,
      ...REPORT_TITLES[key],
      latest: latest ? { id: latest.id, generatedAt: latest.generatedAt } : null,
    };
  });
}

export { REPORT_KEYS, REPORT_TITLES, isReportKey } from "./types";
export { PERIOD_DAYS, generateInput, normalizeFilters, reportFilters } from "./schemas";
export type { Figure, ReportData, ReportKey } from "./types";
export { figureText, filtersQuery } from "./format";
export {
  runWeeklyDigest,
  ensureWeeklySnapshots,
  getLatestDigest,
  businessWeekStart,
  DIGEST_REPORTS,
  type DigestDeps,
  type DigestResult,
  type LatestDigest,
} from "./digest.service";

// Pilot metrics (M12 B5): Admin and CS Leader only.
export {
  PILOT_WEEK_OPTIONS,
  canViewPilotMetrics,
  listPilotRecords,
  loadPilotMetrics,
  pickFigure,
  pilotQuery,
  type PilotQuery,
} from "./pilot-report";
export type { PilotFigure, PilotFigureKey } from "./pilot-metrics";

// Portfolio health trend (spec §5 Reports / Health overview)
export { portfolioHealthTrend, type HealthTrendInput } from "./portfolio-health-trend";
