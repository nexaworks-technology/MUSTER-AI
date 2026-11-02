import type { AuditActorType, AuditLog, Prisma } from "@prisma/client";
import { scopedDb } from "@/lib/db/scoped";

/**
 * The audit write primitive (Rule 5, spec §6N2). Append-only at the database level; values that
 * look like secrets are redacted before they are stored.
 */
export interface AuditEntry {
  workspaceId: string;
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  agentRunId?: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

const SECRET_KEY = /pass(word)?|token|secret|authorization|cookie|credential|api[-_]?key/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[REDACTED]" : redact(v)]),
  );
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(redact(value))) as Prisma.InputJsonValue;
}

export function auditData(entry: AuditEntry): Prisma.AuditLogUncheckedCreateInput {
  return {
    workspaceId: entry.workspaceId,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    agentRunId: entry.agentRunId ?? null,
    summary: entry.summary,
    before: toJson(entry.before),
    after: toJson(entry.after),
    ip: entry.ip ?? null,
  };
}

/** Writes one audit row. Pass `tx` to write inside an existing tenant transaction. */
export async function writeAudit(
  entry: AuditEntry,
  tx?: Prisma.TransactionClient,
): Promise<AuditLog> {
  const data = auditData(entry);
  if (tx) return tx.auditLog.create({ data });
  return scopedDb({ workspaceId: entry.workspaceId }).auditLog.create({ data });
}
