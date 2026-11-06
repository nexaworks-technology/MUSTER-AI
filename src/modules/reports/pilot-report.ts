import { z } from "zod";
import { ForbiddenError, type MemberAccess } from "@/lib/auth/permissions";
import { todayIn, businessClock, type Clock } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import {
  computePilotMetrics,
  PILOT_FIGURE_KEYS,
  type PilotFigure,
  type PilotFigureKey,
  type PilotMetrics,
} from "./pilot-metrics";

/**
 * Reports › Pilot metrics (M12 B5, spec §11). Admin and CS Leader only: it shows each CSM's own
 * usage, which a CSM must not see about their colleagues. There is no new permission; the gate is
 * the role, in code, beside the existing `reports:view`.
 */
export const PILOT_WEEK_OPTIONS = [4, 8, 12] as const;
export const pilotQuery = z.object({
  weeks: z.coerce
    .number()
    .refine((n) => (PILOT_WEEK_OPTIONS as readonly number[]).includes(n))
    .default(4),
  member: z.string().min(1).max(60).optional(),
  figure: z.enum(PILOT_FIGURE_KEYS).optional(),
  week: z
    .string()
    .regex(/^\d{4}-W\d{2}$/)
    .optional(),
});
export type PilotQuery = z.infer<typeof pilotQuery>;

export type PilotViewer = Pick<MemberAccess, "role"> & { workspaceId: string };

export const canViewPilotMetrics = (m: Pick<MemberAccess, "role">): boolean =>
  m.role === "ADMIN" || m.role === "CS_LEADER";

export function requirePilotAccess(m: Pick<MemberAccess, "role">): void {
  if (!canViewPilotMetrics(m))
    throw new ForbiddenError("reports:view", "Pilot metrics are for Admins and CS Leaders.");
}

// A prep pair can start before the period and be shared inside it.
const LOOKBACK_DAYS = 30;
const RECORD_CAP = 200;

export async function loadPilotMetrics(
  ctx: PilotViewer & { workspace: { timezone: string } },
  query: PilotQuery,
  clock: Clock = businessClock,
): Promise<PilotMetrics> {
  requirePilotAccess(ctx);
  const db = scopedDb(ctx);
  const asOf = String(todayIn(ctx.workspace.timezone, clock));
  const memberships = await db.membership.findMany({
    where: { status: "ACTIVE", role: { in: ["ADMIN", "CS_LEADER", "CSM"] } },
    select: { id: true, user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
  const members = memberships.map((m) => ({ id: m.id, name: m.user.name ?? m.user.email }));
  // The earliest instant that could matter: the first week's Monday, less a day for timezones,
  // less the prep lookback.
  const probe = computePilotMetrics({
    events: [],
    members: [],
    weeks: query.weeks,
    asOf,
    timezone: ctx.workspace.timezone,
  });
  const from = new Date(
    Date.parse(`${probe.periodStart}T00:00:00Z`) - (LOOKBACK_DAYS + 1) * 86_400_000,
  );
  const rows = await db.productEvent.findMany({
    where: { occurredAt: { gte: from }, membershipId: { in: members.map((m) => m.id) } },
    select: { id: true, membershipId: true, name: true, subjectId: true, occurredAt: true },
    orderBy: { occurredAt: "asc" },
  });
  return computePilotMetrics({
    events: rows,
    members,
    weeks: query.weeks,
    asOf,
    timezone: ctx.workspace.timezone,
  });
}

/** The figure a link points at: one member, one figure, one week (or the whole period). */
export function pickFigure(
  metrics: PilotMetrics,
  q: Pick<PilotQuery, "member" | "figure" | "week">,
): { member: PilotMetrics["members"][number]; figure: PilotFigure; key: PilotFigureKey } | null {
  const member = metrics.members.find((m) => m.membershipId === q.member);
  if (!member || !q.figure) return null;
  const figures = q.week ? member.weekly[q.week] : member.period;
  return figures ? { member, figure: figures[q.figure], key: q.figure } : null;
}

export interface PilotRecord {
  id: string;
  name: string;
  occurredAt: Date;
  subjectType: string | null;
  subjectId: string | null;
  props: Record<string, unknown>;
}

/** The ProductEvent rows behind one figure, newest first (capped). */
export async function listPilotRecords(
  ctx: PilotViewer,
  ids: readonly string[],
): Promise<{ rows: PilotRecord[]; total: number }> {
  requirePilotAccess(ctx);
  const rows = await scopedDb(ctx).productEvent.findMany({
    where: { id: { in: ids.slice(0, 5_000) as string[] } },
    orderBy: { occurredAt: "desc" },
    take: RECORD_CAP,
  });
  return {
    total: ids.length,
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      occurredAt: r.occurredAt,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      props: (r.props ?? {}) as Record<string, unknown>,
    })),
  };
}
