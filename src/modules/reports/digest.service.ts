import type { AgentRun, NotificationType } from "@prisma/client";
import { env } from "@/lib/config/env";
import {
  addDays,
  businessClock,
  todayIn,
  utcMidnight,
  type CalendarDate,
  type Clock,
} from "@/lib/dates";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { sendStaffEmail, type StaffEmail } from "@/lib/email";
import { ForbiddenError, requirePermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logger";
import type { Actor } from "@/modules/accounts/service";
import {
  leaderReporter,
  leaderReporterOutput,
  runAgent,
  type ExecutorDeps,
} from "@/modules/agents/service";
import { sendLeaderDigest, type SlackDeps } from "@/modules/integrations/service";
import { filtersHash, generateReport } from "./service";
import { normalizeFilters, reportFilters } from "./schemas";
import { REPORT_TITLES, isReportKey, type ReportKey } from "./types";

/**
 * The weekly leader digest (M11 S7, spec §5 Reports; ARCHITECTURE §6.2 row 13). Once per business
 * week and workspace: store the week's SCHEDULED report snapshots (workspace-wide), let the Leader
 * Reporter write a short digest from their figures, and, only if that run SUCCEEDED, tell the
 * workspace's Admins and CS Leaders (in-app, staff email, Slack). Customers are never recipients.
 *
 * Money: the agent is never given a money figure, so the one narrative is safe for every
 * recipient whatever their revenue access (D-75, Rule 4); money is shown only in the linked
 * in-app reports, redacted at read time for anyone without revenue access.
 *
 * If the run did not succeed nothing written by AI is delivered: each leader gets an honest
 * in-app notice that the reports are ready (no AI text).
 */
export const DIGEST_REPORTS: readonly ReportKey[] = [
  "portfolio-health-trend",
  "renewal-outcomes",
  "expansion-found",
  "support-risk",
];

const DIGEST_TRIGGER = "weekly-digest";

/** The Monday of the business week containing `date` (a business date in the workspace's zone). */
export function businessWeekStart(date: CalendarDate): CalendarDate {
  return addDays(date, -((utcMidnight(date).getUTCDay() + 6) % 7));
}

export interface DigestDeps {
  executor?: ExecutorDeps;
  slack?: SlackDeps;
  /** Test seam for the staff-email transport. */
  sendEmail?: (message: StaffEmail) => Promise<unknown>;
}

export interface DigestResult {
  weekStart: CalendarDate;
  status: "DELIVERED" | "ALREADY_DELIVERED" | "NOT_WRITTEN" | "NO_RECIPIENTS";
  runId: string | null;
  notified: number;
  emailed: number;
  slackSent: number;
}

interface Leader {
  membershipId: string;
  role: "ADMIN" | "CS_LEADER";
  userId: string;
  email: string;
}

/** Internal readers only: active Admins and CS Leaders of THIS workspace (scoped read). */
async function leaders(ctx: TenantContext): Promise<Leader[]> {
  const rows = await scopedDb(ctx).membership.findMany({
    where: { status: "ACTIVE", role: { in: ["ADMIN", "CS_LEADER"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, userId: true, user: { select: { email: true } } },
  });
  return rows.map((m) => ({
    membershipId: m.id,
    role: m.role as Leader["role"],
    userId: m.userId,
    email: m.user.email,
  }));
}

/** The whole-workspace actor the scheduled snapshots are computed for (never stored on the row). */
const snapshotActor = (ctx: TenantContext, l: Leader): Actor => ({
  workspaceId: ctx.workspaceId,
  userId: l.userId,
  membershipId: l.membershipId,
  role: l.role,
  canViewRevenue: true,
  bookScope: "ALL",
});

/**
 * The week's snapshots, generated once: the 7 days before the week's Monday, workspace-wide.
 * Re-running in the same week reuses them, so the agent's input (and its run) is unchanged.
 */
export async function ensureWeeklySnapshots(
  ctx: TenantContext & { timezone: string },
  clock: Clock = businessClock,
): Promise<{ weekStart: CalendarDate; snapshotIds: string[] } | null> {
  const weekStart = businessWeekStart(todayIn(ctx.timezone, clock));
  const [first] = await leaders(ctx);
  if (!first) return null;
  const actor = snapshotActor(ctx, first);
  const filters = { start: addDays(weekStart, -7), end: addDays(weekStart, -1) };
  const hash = filtersHash(normalizeFilters(reportFilters.parse(filters)), actor, "ALL");
  const db = scopedDb(ctx);
  const snapshotIds: string[] = [];
  for (const key of DIGEST_REPORTS) {
    const existing = await db.reportSnapshot.findFirst({
      where: { reportKey: key, filtersHash: hash, trigger: "SCHEDULED" },
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    snapshotIds.push(
      existing?.id ?? (await generateReport(actor, key, filters, "SCHEDULED", clock)).id,
    );
  }
  return { weekStart, snapshotIds };
}

export interface DigestSource {
  label: string;
  href: string | null;
  missing: boolean;
}
export interface LatestDigest {
  run: Pick<AgentRun, "id" | "status" | "confidence" | "finishedAt" | "model" | "promptVersion">;
  weekStart: string;
  items: Array<{ text: string; sources: DigestSource[] }>;
  /** A newer attempt that did not succeed (its text is never shown). */
  latestAttempt: { id: string; status: AgentRun["status"] } | null;
}

const FIGURE_PATH = /^(.+)#sections\.(\d+)\.figures\.(\d+)$/;

/** A digest run's items, each source resolved to the report it comes from (links, never values). */
async function digestOf(ctx: TenantContext, run: AgentRun): Promise<LatestDigest["items"]> {
  const parsed = leaderReporterOutput.safeParse(run.output);
  if (!parsed.success) return [];
  const ids = new Set(parsed.data.items.flatMap((i) => i.citations.map((c) => c.sourceId)));
  const snapshotIds = [...new Set([...ids].map((id) => id.split("#")[0]!))];
  const rows = await scopedDb(ctx).reportSnapshot.findMany({
    where: { id: { in: snapshotIds } },
    select: { id: true, reportKey: true, data: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const resolve = (sourceId: string): DigestSource => {
    const m = FIGURE_PATH.exec(sourceId);
    const snap = byId.get(m ? m[1]! : sourceId);
    if (!snap || !isReportKey(snap.reportKey))
      return { label: "Report (no longer on record)", href: null, missing: true };
    const data = snap.data as {
      periodStart?: string;
      periodEnd?: string;
      sections?: Array<{ figures: Array<{ label: string }> }>;
    };
    const title = REPORT_TITLES[snap.reportKey].title;
    const figure = m ? data.sections?.[Number(m[2])]?.figures[Number(m[3])] : undefined;
    const q =
      data.periodStart && data.periodEnd ? `?start=${data.periodStart}&end=${data.periodEnd}` : "";
    return {
      label: figure ? `${title}: ${figure.label}` : `${title} report`,
      href: `/reports/${snap.reportKey}${q}`,
      missing: false,
    };
  };
  return parsed.data.items.map((i) => ({
    text: i.text,
    sources: [...new Set(i.citations.map((c) => c.sourceId))].map(resolve),
  }));
}

/** The latest digest a leader may read, or null; a failed or uncited run is never shown. */
export async function getLatestDigest(actor: Actor): Promise<LatestDigest | null> {
  const grant = requirePermission(actor, "reports:view");
  if (grant.scope !== "ALL")
    throw new ForbiddenError("reports:view", "The weekly digest covers the whole workspace.");
  const db = scopedDb(actor);
  const where = { agentKey: leaderReporter.key, triggerType: DIGEST_TRIGGER };
  const [run, latest] = await Promise.all([
    db.agentRun.findFirst({
      where: { ...where, status: "SUCCEEDED" },
      orderBy: [{ finishedAt: "desc" }, { createdAt: "desc" }],
    }),
    db.agentRun.findFirst({ where, orderBy: [{ createdAt: "desc" }] }),
  ]);
  if (!run) return null;
  return {
    run: {
      id: run.id,
      status: run.status,
      confidence: run.confidence,
      finishedAt: run.finishedAt,
      model: run.model,
      promptVersion: run.promptVersion,
    },
    weekStart: run.triggerId,
    items: await digestOf(actor, run),
    latestAttempt:
      latest && latest.status !== "SUCCEEDED" && latest.createdAt > run.createdAt
        ? { id: latest.id, status: latest.status }
        : null,
  };
}

/** Writes the in-app notification once per recipient, type and thing; true when this call wrote it. */
async function notifyOnce(
  ctx: TenantContext,
  n: { recipient: string; type: NotificationType; refType: string; refId: string; title: string },
): Promise<boolean> {
  return scopedDb(ctx).$tenantTransaction(async (tx) => {
    const exists = await tx.notification.findFirst({
      where: {
        recipientMembershipId: n.recipient,
        channel: "IN_APP",
        type: n.type,
        refType: n.refType,
        refId: n.refId,
      },
      select: { id: true },
    });
    if (exists) return false;
    await tx.notification.create({
      data: {
        workspaceId: ctx.workspaceId,
        recipientMembershipId: n.recipient,
        type: n.type,
        title: n.title,
        refType: n.refType,
        refId: n.refId,
      },
    });
    return true;
  });
}

const appLink = (path: string) => `${env().APP_URL}${path}`;

function emailFor(weekStart: string, items: LatestDigest["items"]): Omit<StaffEmail, "to"> {
  const lines = items.flatMap((i) => [
    `- ${i.text}`,
    `  Sources: ${i.sources.map((s) => s.label).join("; ")}`,
  ]);
  return {
    subject: `Weekly digest: week of ${weekStart}`,
    text: [
      `Weekly digest: week of ${weekStart}`,
      "",
      "Written by AI from the computed report figures linked below. It contains no revenue figures.",
      "",
      ...lines,
      "",
      `Open the digest, its sources and the full reports: ${appLink("/reports/digest")}`,
    ].join("\n"),
  };
}

/**
 * One digest pass for one workspace (the `reports.weeklyDigest` job). Idempotent per business
 * week: the snapshots, the agent run and each notification are found again, not repeated.
 */
export async function runWeeklyDigest(
  ctx: TenantContext & { timezone: string },
  clock: Clock = businessClock,
  deps: DigestDeps = {},
): Promise<DigestResult> {
  const weekStart = businessWeekStart(todayIn(ctx.timezone, clock));
  const base = { weekStart, runId: null, notified: 0, emailed: 0, slackSent: 0 };
  const recipients = await leaders(ctx);
  const prepared = recipients.length ? await ensureWeeklySnapshots(ctx, clock) : null;
  if (!prepared) return { ...base, status: "NO_RECIPIENTS" };

  const outcome = await runAgent(
    ctx,
    leaderReporter,
    { snapshotIds: prepared.snapshotIds },
    { type: DIGEST_TRIGGER, id: weekStart },
    { clock, ...deps.executor },
  );

  if (outcome.kind !== "run" || outcome.status !== "SUCCEEDED") {
    const reason =
      outcome.kind === "not_configured"
        ? "AI is not configured, so this week's digest was not written; the reports are ready."
        : "This week's digest could not be written; the reports are ready.";
    let notified = 0;
    for (const r of recipients)
      if (
        await notifyOnce(ctx, {
          recipient: r.membershipId,
          type: "LEADER_DIGEST_FAILED",
          refType: "ReportDigestNotice",
          refId: weekStart,
          title: reason,
        })
      )
        notified++;
    return {
      ...base,
      status: "NOT_WRITTEN",
      runId: outcome.kind === "run" ? outcome.runId : null,
      notified,
    };
  }

  const run = await scopedDb(ctx).agentRun.findFirstOrThrow({ where: { id: outcome.runId } });
  const items = await digestOf(ctx, run);
  let notified = 0;
  let emailed = 0;
  const send = deps.sendEmail ?? sendStaffEmail;
  for (const r of recipients) {
    const wrote = await notifyOnce(ctx, {
      recipient: r.membershipId,
      type: "LEADER_DIGEST",
      refType: "ReportDigest",
      refId: run.id,
      title: `Your weekly digest is ready: week of ${weekStart}`,
    });
    if (!wrote) continue;
    notified++;
    try {
      await send({ to: r.email, ...emailFor(weekStart, items) });
      emailed++;
    } catch (err) {
      logger.warn(
        { workspaceId: ctx.workspaceId, err: err instanceof Error ? err.name : "unknown" },
        "leader digest email failed",
      );
    }
  }
  let slackSent = 0;
  try {
    slackSent = (
      await sendLeaderDigest(
        ctx,
        {
          runId: run.id,
          weekStart,
          lines: items.map((i) => i.text),
          recipientMembershipIds: recipients.map((r) => r.membershipId),
        },
        deps.slack,
      )
    ).sent;
  } catch (err) {
    logger.warn(
      { workspaceId: ctx.workspaceId, err: err instanceof Error ? err.name : "unknown" },
      "leader digest slack failed",
    );
  }
  return {
    ...base,
    status: notified > 0 || slackSent > 0 ? "DELIVERED" : "ALREADY_DELIVERED",
    runId: run.id,
    notified,
    emailed,
    slackSent,
  };
}
