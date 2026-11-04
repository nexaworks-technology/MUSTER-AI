import { writeAudit } from "@/lib/audit";
import { daysBetween, businessClock, calendarDateOf, todayIn, type Clock } from "@/lib/dates";
import { scopedDb, type ScopedDb, type TenantContext } from "@/lib/db/scoped";
import { formatCalendarDate } from "@/lib/format";
import {
  getAccount,
  requireEditableAccount,
  AccountNotFoundError,
  type Actor,
} from "@/modules/accounts/service";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { briefMetrics, type BriefFacts } from "./renewal-brief";
import { createDocument, DocumentError, readDocument, type DocumentView } from "./service";

/**
 * The Renewal Brief (M7 B3, spec §6H2): a Document of kind RENEWAL_BRIEF whose metrics are read
 * from records by code and locked. A person builds it with one click (no model needed); the
 * Renewal Manager attaches its narrative to a brief built the same way.
 */
const money = (v: bigint | null) => v;

/** Everything the brief's metrics read, for one renewal as of a date: a fixed number of reads. */
export async function loadBriefFacts(
  db: ScopedDb,
  renewalId: string,
  asOf: string,
): Promise<{ facts: BriefFacts; accountId: string; accountName: string } | null> {
  const r = await db.renewal.findUnique({
    where: { id: renewalId },
    select: {
      id: true,
      accountId: true,
      contractId: true,
      renewalDate: true,
      noticeDeadline: true,
      confidence: true,
      confidenceBand: true,
      arrAtRiskMinor: true,
      currency: true,
      account: {
        select: {
          name: true,
          currentHealth: {
            select: {
              id: true,
              riskLevel: true,
              overall: true,
              adoption: true,
              engagement: true,
              support: true,
              relationship: true,
              commercial: true,
              sentiment: true,
            },
          },
        },
      },
    },
  });
  if (!r) return null;
  const [signals, goals, opportunity] = await Promise.all([
    db.signal.findMany({
      where: {
        accountId: r.accountId,
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        polarity: "RISK",
        severity: { in: ["WARN", "CRITICAL"] },
        category: { not: "OUTSIDE" },
      },
      select: { id: true, title: true, severity: true },
      orderBy: [{ severity: "desc" }, { id: "asc" }],
    }),
    db.goal.findMany({
      where: { accountId: r.accountId },
      select: { id: true, status: true },
      orderBy: { id: "asc" },
    }),
    db.expansionOpportunity.findFirst({
      where: { accountId: r.accountId, status: { in: ["OPEN", "IN_PROGRESS"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, signalIds: true, estimateMinor: true, currency: true },
    }),
  ]);
  const titles = opportunity
    ? (
        await db.signal.findMany({
          where: { id: { in: opportunity.signalIds } },
          select: { title: true },
          orderBy: { id: "asc" },
        })
      ).map((s) => s.title)
    : [];
  const h = r.account.currentHealth;
  const n = (d: { toString(): string } | null) => (d === null ? null : Number(d.toString()));
  return {
    accountId: r.accountId,
    accountName: r.account.name,
    facts: {
      renewal: {
        id: r.id,
        contractId: r.contractId,
        dateText: formatCalendarDate(r.renewalDate),
        daysTo: daysBetween(asOf, calendarDateOf(r.renewalDate)),
        noticeDeadlineText: r.noticeDeadline ? formatCalendarDate(r.noticeDeadline) : null,
        confidence: r.confidence,
        band: r.confidenceBand,
        arrMinor: money(r.arrAtRiskMinor),
        currency: r.currency,
      },
      health: h
        ? {
            snapshotId: h.id,
            band: h.riskLevel,
            overall: n(h.overall),
            parts: {
              adoption: n(h.adoption),
              engagement: n(h.engagement),
              support: n(h.support),
              relationship: n(h.relationship),
              commercial: n(h.commercial),
              sentiment: n(h.sentiment),
            },
          }
        : null,
      risks: signals.map((s) => ({
        id: s.id,
        title: s.title,
        severity: s.severity as "WARN" | "CRITICAL",
      })),
      goals: goals.map((g) => ({ id: g.id, status: g.status })),
      expansion: opportunity
        ? {
            id: opportunity.id,
            titles,
            estimateMinor: opportunity.estimateMinor,
            currency: opportunity.currency,
          }
        : null,
    },
  };
}

/** One click: lock the metrics now from the records. The narrative starts empty. */
export async function createRenewalBrief(
  actor: Actor,
  renewalId: string,
  clock: Clock = businessClock,
) {
  const db = scopedDb(actor);
  const row = await db.renewal.findUnique({
    where: { id: renewalId },
    select: { accountId: true },
  });
  if (!row) throw new DocumentError("This renewal does not exist.");
  try {
    await requireEditableAccount(actor, row.accountId);
  } catch (e) {
    if (e instanceof AccountNotFoundError) throw new DocumentError("This renewal does not exist.");
    throw e;
  }
  const asOf = todayIn((await getOwnWorkspace(actor)).timezone, clock);
  const loaded = await loadBriefFacts(db, renewalId, asOf);
  if (!loaded) throw new DocumentError("This renewal does not exist.");
  return attachBrief(actor, renewalId, loaded, [], { origin: "HUMAN" });
}

/** Locks the metrics, writes the document and points the renewal at it (one transaction). */
export async function attachBrief(
  ctx: TenantContext,
  renewalId: string,
  loaded: { facts: BriefFacts; accountId: string; accountName: string },
  narrative: Parameters<typeof createDocument>[1]["narrative"],
  by: { origin: "HUMAN" | "AI"; agentRunId?: string },
) {
  return scopedDb(ctx).$tenantTransaction(async (tx) => {
    const doc = await createDocument(
      ctx,
      {
        accountId: loaded.accountId,
        kind: "RENEWAL_BRIEF",
        title: `Renewal brief: ${loaded.accountName}, ${loaded.facts.renewal.dateText}`,
        metrics: briefMetrics(loaded.facts),
        narrative,
        origin: by.origin === "AI" ? "AI" : "HUMAN",
        agentRunId: by.agentRunId ?? null,
      },
      tx,
    );
    await tx.renewal.update({ where: { id: renewalId }, data: { briefDocumentId: doc.id } });
    await writeAudit(
      {
        workspaceId: ctx.workspaceId,
        actorType: by.origin === "AI" ? "AGENT" : "SYSTEM",
        actorId: by.agentRunId ?? null,
        action: "renewal.brief_attached",
        targetType: "Renewal",
        targetId: renewalId,
        summary: `Attached ${doc.title}`,
      },
      tx,
    );
    return doc;
  });
}

export interface BriefPage {
  renewal: {
    id: string;
    accountId: string;
    accountName: string;
    renewalDate: Date;
    stage: string;
  };
  document: DocumentView | null;
}

/** The brief page's read: the renewal and its current brief (or none yet). */
export async function getRenewalBrief(actor: Actor, renewalId: string): Promise<BriefPage> {
  const db = scopedDb(actor);
  const r = await db.renewal.findUnique({
    where: { id: renewalId },
    select: {
      id: true,
      accountId: true,
      renewalDate: true,
      stage: true,
      briefDocumentId: true,
      account: { select: { name: true } },
    },
  });
  if (!r || !(await getAccount(actor, r.accountId)))
    throw new DocumentError("This renewal does not exist.");
  return {
    renewal: {
      id: r.id,
      accountId: r.accountId,
      accountName: r.account.name,
      renewalDate: r.renewalDate,
      stage: r.stage,
    },
    document: r.briefDocumentId ? await readDocument(actor, r.briefDocumentId) : null,
  };
}
