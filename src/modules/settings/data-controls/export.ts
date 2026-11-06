import { randomUUID } from "node:crypto";
import { strToU8, zipSync, type Zippable } from "fflate";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { fieldCipher } from "@/lib/crypto";
import { scopedDb } from "@/lib/db/scoped";
import { lockInTransaction } from "@/lib/db/locks";
import { TENANT_MODELS } from "@/lib/db/tenantModels";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { manualRunId } from "@/lib/jobs/ids";
import { getQueue } from "@/lib/jobs/queues";
import { logger } from "@/lib/logger";
import { getStorage } from "@/lib/storage";
import { UserFacingError, type Actor } from "../service";
import { DECRYPTED_FIELDS, EXCLUDED_COLUMNS, NOT_EXPORTED } from "./export-columns";

/**
 * Workspace data export (M12 B1, spec §6N, D-179). An Admin requests it; the job
 * `maintenance.exportWorkspace` reads every [W] model through scopedDb (RLS), adds the workspace's
 * stored files, zips it, uploads it under the workspace's own storage prefix and records it in the
 * audit log. A signed link is made on demand from that record, valid for 7 days from the export.
 * There is no export table: the audit rows (`data.export_requested|ready|failed`) are the record.
 */
export { EXCLUDED_COLUMNS } from "./export-columns";

export const EXPORT_JOB = "maintenance.exportWorkspace";
export const EXPORT_LINK_TTL_SECONDS = 7 * 86_400;
/** A request with no result after this long no longer blocks a new one (worker died, job lost). */
export const EXPORT_STALE_MS = 30 * 60_000;
const PAGE = 1000;

export type ExportStatus = "running" | "ready" | "failed" | "stalled" | "expired";

export interface ExportRow {
  requestId: string;
  status: ExportStatus;
  requestedAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
  bytes: number | null;
  fileCount: number | null;
}

const A = {
  requested: "data.export_requested",
  ready: "data.export_ready",
  failed: "data.export_failed",
} as const;

const exportPayload = z.object({
  workspaceId: z.string().min(1),
  requestId: z.string().min(1),
  requestedByMembershipId: z.string().min(1).nullable(),
});
export type ExportJobPayload = z.infer<typeof exportPayload>;

const afterOf = (row: { after: unknown }) => (row.after ?? {}) as Record<string, unknown>;

// ─── Status, from the audit trail ────────────────────────────────────────────

interface AuditRow {
  action: string;
  createdAt: Date;
  after: unknown;
}

function foldExports(rows: AuditRow[], now: Date): ExportRow[] {
  const byId = new Map<string, ExportRow>();
  // Oldest first so a later ready/failed row settles the request it names.
  for (const row of [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const after = afterOf(row);
    const requestId = String(after.requestId ?? "");
    if (!requestId) continue;
    if (row.action === A.requested) {
      byId.set(requestId, {
        requestId,
        status: "running",
        requestedAt: row.createdAt,
        readyAt: null,
        expiresAt: null,
        bytes: null,
        fileCount: null,
      });
      continue;
    }
    const entry = byId.get(requestId);
    if (!entry) continue;
    if (row.action === A.failed) entry.status = "failed";
    if (row.action === A.ready) {
      entry.status = "ready";
      entry.readyAt = row.createdAt;
      entry.expiresAt = new Date(String(after.expiresAt));
      entry.bytes = Number(after.bytes ?? 0);
      entry.fileCount = Number(after.fileCount ?? 0);
    }
  }
  const out = [...byId.values()].sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
  for (const e of out) {
    if (e.status === "ready" && e.expiresAt && e.expiresAt <= now) e.status = "expired";
    if (e.status === "running" && now.getTime() - e.requestedAt.getTime() > EXPORT_STALE_MS)
      e.status = "stalled";
  }
  return out;
}

const EXPORT_ACTIONS = [A.requested, A.ready, A.failed];

/** The workspace's recent exports, newest first. Admin only. */
export async function listExports(actor: Actor, now: Date = new Date()): Promise<ExportRow[]> {
  requirePermission(actor, "data:exportDelete");
  const rows = await scopedDb(actor).auditLog.findMany({
    where: { action: { in: EXPORT_ACTIONS } },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { action: true, createdAt: true, after: true },
  });
  return foldExports(rows, now).slice(0, 20);
}

// ─── Request ─────────────────────────────────────────────────────────────────

/**
 * Starts an export. At most one is running per workspace: the check and the audit row share a
 * transaction under an advisory lock, so two clicks cannot both pass.
 */
export async function requestExport(actor: Actor): Promise<{ requestId: string; jobId: string }> {
  requirePermission(actor, "data:exportDelete");
  const requestId = `exp-${randomUUID()}`;
  const jobId = manualRunId();
  await scopedDb(actor).$tenantTransaction(async (tx) => {
    await lockInTransaction(tx, `export:${actor.workspaceId}`);
    const recent = await tx.auditLog.findMany({
      where: { workspaceId: actor.workspaceId, action: { in: EXPORT_ACTIONS } },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { action: true, createdAt: true, after: true },
    });
    if (foldExports(recent, new Date()).some((e) => e.status === "running"))
      throw new UserFacingError(
        "An export is already running for this workspace. Wait for it to finish.",
      );
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: A.requested,
        targetType: "Workspace",
        targetId: actor.workspaceId,
        summary: "Requested an export of all workspace data",
        after: { requestId, jobId },
      },
      tx,
    );
  });
  const payload: ExportJobPayload = {
    workspaceId: actor.workspaceId,
    requestId,
    requestedByMembershipId: actor.membershipId,
  };
  try {
    await getQueue("maintenance").add(EXPORT_JOB, payload, { jobId, attempts: 1 });
  } catch (error) {
    await recordFailure(payload, "The export could not be queued.");
    throw error;
  }
  return { requestId, jobId };
}

// ─── Link ────────────────────────────────────────────────────────────────────

const exportSegments = (requestId: string) => ["exports", `${requestId}.zip`];

/**
 * A signed download link for a finished export. The export is available for 7 days from when it
 * was built; the link lives for 7 days or until then, whichever is sooner. Made on demand and never
 * stored (the audit row keeps the storage key only).
 */
export async function getExportLink(
  actor: Actor,
  requestId: string,
  now: Date = new Date(),
): Promise<{ url: string; expiresAt: Date }> {
  requirePermission(actor, "data:exportDelete");
  const ready = await scopedDb(actor).auditLog.findFirst({
    where: { action: A.ready, after: { path: ["requestId"], equals: requestId } },
    orderBy: { createdAt: "desc" },
  });
  if (!ready) throw new UserFacingError("Export not found.");
  const availableUntil = new Date(String(afterOf(ready).expiresAt));
  if (availableUntil <= now)
    throw new UserFacingError("This export has expired. Request a new one.");
  const seconds = Math.min(
    EXPORT_LINK_TTL_SECONDS,
    Math.max(1, Math.floor((availableUntil.getTime() - now.getTime()) / 1000)),
  );
  const url = await getStorage().signedDownloadUrl(
    actor,
    exportSegments(requestId),
    `workspace-export-${requestId}.zip`,
    seconds,
  );
  return { url, expiresAt: new Date(now.getTime() + seconds * 1000) };
}

// ─── The job ─────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Delegate = { findMany: (args: Row) => Promise<Row[]> };

const delegateOf = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

async function readModel(workspaceId: string, model: string): Promise<Row[]> {
  const db = scopedDb({ workspaceId }) as unknown as Record<string, Delegate>;
  const delegate = db[delegateOf(model)]!;
  const omit = Object.fromEntries(
    [
      ...EXCLUDED_COLUMNS.filter((c) => c.model === model).map((c) => c.column),
      ...(DECRYPTED_FIELDS[model] ?? []).map((f) => f.column),
    ].map((c) => [c, true]),
  );
  const rows: Row[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await delegate.findMany({
      take: PAGE,
      orderBy: { id: "asc" },
      omit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    rows.push(...page);
    if (page.length < PAGE) return rows;
    cursor = String(page[page.length - 1]!.id);
  }
}

/** Contract terms and pricing notes, decrypted: the customer's own data. */
async function readContracts(workspaceId: string): Promise<Row[]> {
  const db = scopedDb({ workspaceId });
  const cipher = fieldCipher();
  const sealed = await db.contract.findMany({
    select: { id: true, termsEnc: true, pricingNotesEnc: true },
  });
  const plain = new Map(
    sealed.map((c) => [
      c.id,
      {
        terms: cipher.decryptNullable(c.termsEnc),
        pricingNotes: cipher.decryptNullable(c.pricingNotesEnc),
      },
    ]),
  );
  return (await readModel(workspaceId, "Contract")).map((row) => ({
    ...row,
    ...plain.get(String(row.id)),
  }));
}

const jsonReplacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);

async function readFiles(workspaceId: string, rows: Row[]) {
  const storage = getStorage();
  const prefix = `ws/${workspaceId}/`;
  const entries: Zippable = {};
  const missing: Array<{ id: string; reason: string }> = [];
  let bytes = 0;
  for (const f of rows) {
    const id = String(f.id);
    const key = String(f.storageKey);
    if (!key.startsWith(prefix)) {
      missing.push({ id, reason: "Stored outside this workspace's prefix; not read." });
      continue;
    }
    try {
      const body = await storage.get({ workspaceId }, key.slice(prefix.length).split("/"));
      entries[`files/${id}-${safeName(String(f.filename))}`] = [body, { level: 0 }];
      bytes += body.byteLength;
    } catch {
      missing.push({ id, reason: "The stored object could not be read." });
    }
  }
  return { entries, missing, bytes, count: Object.keys(entries).length };
}

async function recordFailure(payload: ExportJobPayload, reason: string): Promise<void> {
  await writeAudit({
    workspaceId: payload.workspaceId,
    actorType: "SYSTEM",
    action: A.failed,
    targetType: "Workspace",
    targetId: payload.workspaceId,
    summary: "Workspace export failed",
    after: { requestId: payload.requestId, reason },
  });
}

export interface ExportHooks {
  /** Runs after the ZIP is built and before it is stored (tests use it to fail the job). */
  afterBuild?: () => void | Promise<void>;
}

/** The `maintenance.exportWorkspace` job. Idempotent per request: a finished export is not rebuilt. */
export async function runExportJob(input: ExportJobPayload, hooks: ExportHooks = {}) {
  const payload = exportPayload.parse(input);
  const { workspaceId, requestId } = payload;
  const db = scopedDb({ workspaceId });
  const done = await db.auditLog.findFirst({
    where: { action: A.ready, after: { path: ["requestId"], equals: requestId } },
  });
  if (done) return { requestId, storageKey: String(afterOf(done).storageKey), reused: true };
  try {
    const workspace = await getOwnWorkspace({ workspaceId });
    const zip: Zippable = {};
    const counts: Record<string, number> = {};
    let fileRows: Row[] = [];
    for (const model of TENANT_MODELS) {
      const rows =
        model === "Contract"
          ? await readContracts(workspaceId)
          : await readModel(workspaceId, model);
      counts[model] = rows.length;
      if (model === "FileObject") fileRows = rows;
      zip[`data/${model}.json`] = strToU8(JSON.stringify(rows, jsonReplacer, 2));
    }
    const files = await readFiles(workspaceId, fileRows);
    const exportedAt = new Date();
    const expiresAt = new Date(exportedAt.getTime() + EXPORT_LINK_TTL_SECONDS * 1000);
    zip["manifest.json"] = strToU8(
      JSON.stringify(
        {
          format: "nexaworks-workspace-export/1",
          exportedAt: exportedAt.toISOString(),
          availableUntil: expiresAt.toISOString(),
          workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
          requestId,
          counts,
          files: { count: files.count, bytes: files.bytes, missing: files.missing },
          excludedColumns: EXCLUDED_COLUMNS,
          decryptedFields: Object.entries(DECRYPTED_FIELDS).flatMap(([model, fields]) =>
            fields.map((f) => ({ model, storedAs: f.column, exportedAs: f.exportedAs })),
          ),
          notExported: NOT_EXPORTED,
          notes: [
            "Exports are Admin-only (data:exportDelete) and include money: ARR, contract values, invoices and revenue events are exported in full whatever each member's financial-view setting is.",
            "BigInt values (amounts in minor units) are strings; timestamps are ISO 8601 in UTC.",
            "Contract terms and pricing notes are decrypted: they are the customer's own data. Integration credentials and link-token hashes are never exported.",
            "Files in data/FileObject.json name each stored file; the bytes are under files/ as <file id>-<filename>.",
          ],
        },
        jsonReplacer,
        2,
      ),
    );
    Object.assign(zip, files.entries);
    const archive = zipSync(zip);
    await hooks.afterBuild?.();
    const storage = getStorage();
    await storage.ensureBucket();
    const { key } = await storage.put(
      { workspaceId },
      exportSegments(requestId),
      archive,
      "application/zip",
    );
    await writeAudit({
      workspaceId,
      actorType: "SYSTEM",
      action: A.ready,
      targetType: "Workspace",
      targetId: workspaceId,
      summary: `Workspace export ready: ${Object.values(counts).reduce((a, b) => a + b, 0)} records, ${files.count} files`,
      after: {
        requestId,
        storageKey: key,
        bytes: archive.byteLength,
        fileCount: files.count,
        counts,
        requestedByMembershipId: payload.requestedByMembershipId,
        expiresAt: expiresAt.toISOString(),
      },
    });
    return { requestId, storageKey: key, bytes: archive.byteLength, counts, reused: false };
  } catch (error) {
    logger.error(
      { workspaceId, requestId, err: error instanceof Error ? error.name : "unknown" },
      "workspace export failed",
    );
    await recordFailure(payload, "The export could not be built.");
    throw error;
  }
}
