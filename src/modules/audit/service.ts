import type { AuditLog, Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";

/**
 * The audit trail (spec §6N2): every human and AI decision, viewable by Admins and CS Leaders and
 * exportable by Admins as CSV or JSON. The export is itself audited. Workspace-scoped like every
 * other read, so an export can only ever contain this workspace's rows.
 */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .or(z.literal("").transform(() => undefined));

export const auditQuery = z.object({
  actorType: z
    .enum(["USER", "AGENT", "SYSTEM", "INTEGRATION", "PORTAL_CONTACT"])
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /** A user id, an agent key, or a name fragment. */
  actor: z.string().trim().max(200).optional(),
  /** One or more action prefixes, comma-separated: "agent.run,approval.,outbound.". */
  action: z.string().trim().max(200).optional(),
  targetType: z.string().trim().max(60).optional(),
  targetId: z.string().trim().max(60).optional(),
  from: day,
  to: day,
  cursor: z.coerce.number().int().min(0).default(0),
});
export type AuditQuery = z.infer<typeof auditQuery>;

export const AUDIT_PAGE = 50;
export const EXPORT_LIMIT = 10_000;

async function whereFor(actor: Actor, q: AuditQuery): Promise<Prisma.AuditLogWhereInput> {
  const and: Prisma.AuditLogWhereInput[] = [];
  if (q.actorType) and.push({ actorType: q.actorType });
  if (q.actor) {
    const users = await scopedDb(actor).membership.findMany({
      where: {
        user: {
          OR: [
            { name: { contains: q.actor, mode: "insensitive" } },
            { email: { contains: q.actor, mode: "insensitive" } },
          ],
        },
      },
      select: { userId: true },
    });
    and.push({ OR: [{ actorId: q.actor }, { actorId: { in: users.map((u) => u.userId) } }] });
  }
  const prefixes = (q.action ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (prefixes.length) and.push({ OR: prefixes.map((p) => ({ action: { startsWith: p } })) });
  if (q.targetType) and.push({ targetType: q.targetType });
  if (q.targetId) and.push({ OR: [{ targetId: q.targetId }, { agentRunId: q.targetId }] });
  if (q.from) and.push({ createdAt: { gte: new Date(`${q.from}T00:00:00Z`) } });
  if (q.to) and.push({ createdAt: { lt: new Date(Date.parse(`${q.to}T00:00:00Z`) + 86_400_000) } });
  return and.length ? { AND: and } : {};
}

async function actorNames(actor: Actor, rows: AuditLog[]) {
  const ids = [
    ...new Set(rows.filter((r) => r.actorType === "USER" && r.actorId).map((r) => r.actorId!)),
  ];
  const members = await scopedDb(actor).membership.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, user: { select: { name: true, email: true } } },
  });
  return new Map(members.map((m) => [m.userId, m.user.name ?? m.user.email]));
}

export const actorLabel = (r: AuditLog, names: Map<string, string>) =>
  r.actorType === "USER"
    ? (names.get(r.actorId ?? "") ?? "A former member")
    : r.actorType === "AGENT"
      ? `AI: ${r.actorId ?? "agent"}`
      : r.actorType === "SYSTEM"
        ? "System"
        : r.actorType.toLowerCase();

export async function listAudit(actor: Actor, raw: unknown = {}) {
  requirePermission(actor, "audit:view");
  const q = auditQuery.parse(raw);
  const db = scopedDb(actor);
  const where = await whereFor(actor, q);
  const [rows, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: q.cursor,
      take: AUDIT_PAGE,
    }),
    db.auditLog.count({ where }),
  ]);
  const names = await actorNames(actor, rows);
  return {
    query: q,
    total,
    next: q.cursor + AUDIT_PAGE < total ? q.cursor + AUDIT_PAGE : null,
    rows: rows.map((r) => ({ ...r, actorLabel: actorLabel(r, names) })),
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  // Cells that a spreadsheet would run as a formula are prefixed (CSV injection).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export const EXPORT_COLUMNS = [
  "createdAt",
  "actorType",
  "actorId",
  "actor",
  "action",
  "targetType",
  "targetId",
  "agentRunId",
  "summary",
  "before",
  "after",
] as const;

/** Admin-only export of the filtered trail (up to EXPORT_LIMIT rows), audited as "audit.exported". */
export async function exportAudit(actor: Actor, raw: unknown, format: "csv" | "json") {
  requirePermission(actor, "audit:export");
  const q = auditQuery.parse(raw);
  const where = await whereFor(actor, q);
  const rows = await scopedDb(actor).auditLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: EXPORT_LIMIT,
  });
  const names = await actorNames(actor, rows);
  const records = rows.map((r) => ({
    createdAt: r.createdAt.toISOString(),
    actorType: r.actorType,
    actorId: r.actorId,
    actor: actorLabel(r, names),
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    agentRunId: r.agentRunId,
    summary: r.summary,
    before: r.before,
    after: r.after,
  }));
  const body =
    format === "json"
      ? JSON.stringify(records, null, 2)
      : [
          EXPORT_COLUMNS.join(","),
          ...records.map((rec) => EXPORT_COLUMNS.map((c) => csvCell(rec[c])).join(",")),
        ].join("\r\n");
  const { cursor: _cursor, ...filters } = q;
  await writeAudit({
    workspaceId: actor.workspaceId,
    actorType: "USER",
    actorId: actor.userId,
    action: "audit.exported",
    targetType: "AuditLog",
    summary: `Exported ${records.length} audit row(s) as ${format.toUpperCase()}`,
    after: { format, rows: records.length, filters, truncated: rows.length === EXPORT_LIMIT },
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    filename: `audit-${stamp}.${format}`,
    contentType: format === "json" ? "application/json" : "text/csv; charset=utf-8",
    body,
    count: records.length,
  };
}
