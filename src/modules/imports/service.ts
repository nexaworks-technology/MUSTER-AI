import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { getOwnWorkspace } from "@/lib/db/workspace";
import { getQueue } from "@/lib/jobs/queues";
import { logger } from "@/lib/logger";
import { getStorage } from "@/lib/storage";
import type { Actor } from "@/modules/accounts/service";
import { recomputeCommercials } from "@/modules/billing/service";
import { storeUpload, UploadRejectedError } from "@/modules/files/service";
import { autoMap, parseCsv, validateRows, type RowError } from "./parse";
import { TEMPLATES, type ImportKind } from "./templates";
import { planRecords, type PlannedRow } from "./writers";

export { TEMPLATES, templateBySlug, templateCsv } from "./templates";
export type { ImportKind } from "./templates";
export { UploadRejectedError };

/**
 * CSV import (spec §6B, D-47): upload → column mapping → preview (dry run: validates the whole
 * file and plans every row, writes nothing to the Account Graph) → confirm → background run in
 * chunks of 200, each in its own tenant transaction → result report. Re-running the same file
 * creates nothing new. Every step is audited.
 */
export const CHUNK_SIZE = 200;
const REPORT_CAP = 500;

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export interface ImportReport {
  errors: RowError[];
  totalErrors: number;
  preview?: { create: number; update: number; unchanged: number; fail: number };
}

export async function startImport(
  actor: Actor,
  kind: ImportKind,
  file: { filename: string; bytes: Uint8Array },
) {
  requirePermission(actor, "data:import");
  const parsed = parseCsv(file.bytes);
  if (!parsed.ok) throw new ImportError(parsed.error);
  const stored = await storeUpload(actor, {
    purpose: "CSV_IMPORT",
    filename: file.filename,
    bytes: file.bytes,
  });
  const db = scopedDb(actor);
  return db.$tenantTransaction(async (tx) => {
    const job = await tx.importJob.create({
      data: {
        workspaceId: actor.workspaceId,
        kind,
        fileObjectId: stored.id,
        headers: parsed.headers,
        mapping: autoMap(parsed.headers, TEMPLATES[kind]),
        rowsTotal: parsed.rows.length,
        createdByMembershipId: actor.membershipId,
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "import.uploaded",
        targetType: "ImportJob",
        targetId: job.id,
        summary: `Uploaded ${stored.filename} for a ${TEMPLATES[kind].title.toLowerCase()} import`,
        after: { rows: parsed.rows.length },
      },
      tx,
    );
    return job;
  });
}

export async function getImport(actor: Actor, jobId: string) {
  requirePermission(actor, "data:import");
  const job = await scopedDb(actor).importJob.findUnique({
    where: { id: jobId },
    include: { file: { select: { filename: true } } },
  });
  if (!job) throw new ImportError("That import was not found.");
  return {
    ...job,
    mapping: job.mapping as Record<string, string>,
    report: job.report as ImportReport | null,
  };
}

export async function listImports(actor: Actor) {
  requirePermission(actor, "data:import");
  return scopedDb(actor).importJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { file: { select: { filename: true } } },
  });
}

const mappingInput = z.record(z.string(), z.string());

export async function setMapping(actor: Actor, jobId: string, raw: unknown) {
  const job = await getImport(actor, jobId);
  if (!["UPLOADED", "PREVIEWED"].includes(job.status))
    throw new ImportError("This import has already started; the mapping can't change.");
  const mapping = Object.fromEntries(
    Object.entries(mappingInput.parse(raw)).filter(([, col]) => col !== ""),
  );
  const fields = new Set(TEMPLATES[job.kind].fields.map((f) => f.key));
  for (const [field, col] of Object.entries(mapping)) {
    if (!fields.has(field) || !job.headers.includes(col))
      throw new ImportError("The mapping names a column that isn't in the file.");
  }
  await scopedDb(actor).importJob.update({
    where: { id: jobId },
    data: { mapping, status: "UPLOADED" },
  });
}

async function loadRows(workspaceId: string, fileObjectId: string) {
  const file = await scopedDb({ workspaceId }).fileObject.findUniqueOrThrow({
    where: { id: fileObjectId },
  });
  const prefix = `ws/${workspaceId}/`;
  if (!file.storageKey.startsWith(prefix) || file.scanStatus !== "CLEAN")
    throw new ImportError(
      "The uploaded file isn't available (it may still be waiting for a security scan).",
    );
  const storage = getStorage();
  await storage.ensureBucket();
  const parsed = parseCsv(
    await storage.get({ workspaceId }, file.storageKey.slice(prefix.length).split("/")),
  );
  if (!parsed.ok) throw new ImportError(parsed.error);
  return parsed;
}

async function validateJob(
  workspaceId: string,
  job: { kind: ImportKind; fileObjectId: string; mapping: unknown },
) {
  const template = TEMPLATES[job.kind];
  const mapping = job.mapping as Record<string, string>;
  const missing = template.fields.filter((f) => f.required && !mapping[f.key]).map((f) => f.key);
  if (missing.length) throw new ImportError(`Choose a column for: ${missing.join(", ")}.`);
  const { headers, rows } = await loadRows(workspaceId, job.fileObjectId);
  const workspace = await getOwnWorkspace({ workspaceId });
  return {
    rows,
    ...validateRows(template, headers, rows, mapping, { baseCurrency: workspace.baseCurrency }),
  };
}

const tally = (planned: PlannedRow[]) => ({
  create: planned.filter((p) => p.action === "CREATE").length,
  update: planned.filter((p) => p.action === "UPDATE").length,
  unchanged: planned.filter((p) => p.action === "UNCHANGED").length,
  fail: planned.filter((p) => p.action === "FAIL").length,
});

/** Dry run: validates every row and plans it against current data. Writes nothing but the job's own summary. */
export async function previewImport(actor: Actor, jobId: string) {
  const job = await getImport(actor, jobId);
  if (!["UPLOADED", "PREVIEWED"].includes(job.status))
    throw new ImportError("This import has already started.");
  const { rows, records, errors } = await validateJob(actor.workspaceId, job);
  const planned = await planRecords(
    scopedDb(actor),
    { workspaceId: actor.workspaceId, actorMembershipId: actor.membershipId },
    job.kind,
    records,
  );
  const allErrors = [
    ...errors,
    ...planned.filter((p) => p.action === "FAIL").map((p) => ({ row: p.row, message: p.reason! })),
  ].sort((a, b) => a.row - b.row);
  const preview = tally(planned);
  const report: ImportReport = {
    errors: allErrors.slice(0, REPORT_CAP),
    totalErrors: allErrors.length,
    preview: { ...preview, fail: allErrors.length },
  };
  await scopedDb(actor).importJob.update({
    where: { id: jobId },
    data: {
      status: "PREVIEWED",
      rowsTotal: rows.length,
      rowsValid: records.length - preview.fail,
      report: report as object,
    },
  });
  return report;
}

export async function confirmImport(actor: Actor, jobId: string) {
  const job = await getImport(actor, jobId);
  if (job.status !== "PREVIEWED") throw new ImportError("Preview the import before confirming it.");
  const db = scopedDb(actor);
  await db.$tenantTransaction(async (tx) => {
    const { count } = await tx.importJob.updateMany({
      where: { id: jobId, status: "PREVIEWED" },
      data: { status: "QUEUED", confirmedAt: new Date() },
    });
    if (count === 0) throw new ImportError("This import was already confirmed.");
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "import.confirmed",
        targetType: "ImportJob",
        targetId: jobId,
        summary: `Confirmed the ${TEMPLATES[job.kind].title.toLowerCase()} import`,
      },
      tx,
    );
  });
  await getQueue("sync").add(
    "import.run",
    { workspaceId: actor.workspaceId, importJobId: jobId },
    { jobId: `import-${jobId}`, attempts: 1 },
  );
}

/**
 * The background run (worker, queue `sync`). Re-plans and applies each chunk of 200 valid rows
 * in its own transaction; if a chunk fails, its rows are retried one by one so a single bad row
 * is reported instead of losing its neighbours. Never throws for row problems.
 */
export async function runImportJob(workspaceId: string, importJobId: string): Promise<void> {
  const db = scopedDb({ workspaceId });
  const job = await db.importJob.findUnique({ where: { id: importJobId } });
  if (!job || job.status !== "QUEUED") return;
  await db.importJob.update({
    where: { id: job.id },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  const ctx = { workspaceId, actorMembershipId: job.createdByMembershipId ?? "" };
  const counts = { created: 0, updated: 0, unchanged: 0 };
  const failures: RowError[] = [];
  const touchedAccounts = new Set<string>();
  try {
    const { records, errors } = await validateJob(workspaceId, job);
    failures.push(...errors);
    for (let i = 0; i < records.length; i += CHUNK_SIZE) {
      const chunk = records.slice(i, i + CHUNK_SIZE);
      const planned = await planRecords(db, ctx, job.kind, chunk);
      const applyRows = async (rows: PlannedRow[]) =>
        db.$tenantTransaction(async (tx) => {
          for (const p of rows) await p.apply?.(tx);
          await writeAudit(
            {
              workspaceId,
              actorType: "SYSTEM",
              action: "import.chunk",
              targetType: "ImportJob",
              targetId: job.id,
              summary: `Imported rows ${rows[0]?.row ?? "-"}–${rows.at(-1)?.row ?? "-"}`,
              after: tally(rows),
            },
            tx,
          );
        });
      const writable = planned.filter((p) => p.action === "CREATE" || p.action === "UPDATE");
      let written = writable;
      try {
        if (writable.length) await applyRows(writable);
      } catch (error) {
        logger.warn({ err: error, importJobId }, "import chunk failed; retrying row by row");
        written = [];
        for (const p of writable) {
          try {
            await applyRows([p]);
            written.push(p);
          } catch {
            failures.push({
              row: p.row,
              message: `Row ${p.row}: could not be saved (it may conflict with another record).`,
            });
          }
        }
      }
      for (const p of written) {
        if (p.action === "CREATE") counts.created++;
        else counts.updated++;
        if (p.accountId) touchedAccounts.add(p.accountId);
      }
      counts.unchanged += planned.filter((p) => p.action === "UNCHANGED").length;
      failures.push(
        ...planned
          .filter((p) => p.action === "FAIL")
          .map((p) => ({ row: p.row, message: p.reason! })),
      );
      await db.importJob.update({
        where: { id: job.id },
        data: { ...counts, failed: failures.length },
      });
    }
    if (job.kind === "CONTRACTS" || job.kind === "INVOICES") {
      await db.$tenantTransaction(async (tx) => {
        for (const accountId of touchedAccounts)
          await recomputeCommercials(tx, workspaceId, accountId);
      });
    }
    failures.sort((a, b) => a.row - b.row);
    const report: ImportReport = {
      errors: failures.slice(0, REPORT_CAP),
      totalErrors: failures.length,
      preview: (job.report as ImportReport | null)?.preview,
    };
    await db.importJob.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        ...counts,
        failed: failures.length,
        report: report as object,
      },
    });
    await writeAudit({
      workspaceId,
      actorType: "SYSTEM",
      action: "import.completed",
      targetType: "ImportJob",
      targetId: job.id,
      summary: `Import finished: ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged, ${failures.length} failed`,
      after: { ...counts, failed: failures.length },
    });
  } catch (error) {
    const message =
      error instanceof ImportError
        ? error.message
        : "The import stopped unexpectedly. Rows already saved are kept; you can run it again safely.";
    logger.error({ err: error, importJobId }, "import failed");
    await db.importJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorPlain: message,
        ...counts,
        failed: failures.length,
      },
    });
    await writeAudit({
      workspaceId,
      actorType: "SYSTEM",
      action: "import.failed",
      targetType: "ImportJob",
      targetId: job.id,
      summary: message,
    });
  }
}

export const importJobPayload = z.object({
  workspaceId: z.string().min(1),
  importJobId: z.string().min(1),
});
