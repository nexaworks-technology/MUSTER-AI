import { createHash, randomUUID } from "node:crypto";
import { writeAudit } from "@/lib/audit";
import { can, ForbiddenError, requirePermission } from "@/lib/auth/permissions";
import type { UploadPurpose } from "@/config/uploads";
import { scopedDb } from "@/lib/db/scoped";
import { getStorage, type Storage } from "@/lib/storage";
import { ScannerUnavailableError } from "@/lib/uploads/clamd";
import { getScanner, type MalwareScanner } from "@/lib/uploads/scanner";
import { validateUpload } from "@/lib/uploads/validate";
import { getAccount, requireEditableAccount, type Actor } from "@/modules/accounts/service";

/**
 * Files (ARCHITECTURE §7.6). Every upload: permission → content checks → scan → storage under a
 * key we generate (`ws/<workspaceId>/files/<uuid>`) → FileObject row → audit. Every download:
 * the file must be in the actor's workspace, readable by them (account book; revenue access for
 * contract documents; data:import for CSV imports) and scanned clean. Keys and storage URLs are
 * never sent to the browser.
 */
export class UploadRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadRejectedError";
  }
}

export class FileNotFoundError extends Error {
  constructor() {
    super("File not found");
    this.name = "FileNotFoundError";
  }
}

export class FileNotReadyError extends Error {
  constructor() {
    super("This file is waiting for a security scan and can't be opened yet.");
    this.name = "FileNotReadyError";
  }
}

export interface FileDeps {
  storage?: Storage;
  scanner?: MalwareScanner | null;
}

let bucketReady: Promise<void> | undefined;
function storageWithBucket(storage?: Storage): Storage {
  const s = storage ?? getStorage();
  if (!storage) bucketReady ??= s.ensureBucket();
  return s;
}

async function authorize(
  actor: Actor,
  purpose: UploadPurpose,
  accountId: string | null,
  mode: "read" | "write",
  file?: { uploadedByMembershipId: string | null },
) {
  if (purpose === "ASK_ATTACHMENT") {
    // Owner-only (M11): no account, no revenue permission — only the member who uploaded it.
    if (mode === "read" && file?.uploadedByMembershipId !== actor.membershipId)
      throw new FileNotFoundError();
    return;
  }
  if (purpose === "CSV_IMPORT") {
    requirePermission(actor, "data:import");
    return;
  }
  if (purpose === "CALL_TRANSCRIPT") {
    if (!accountId) throw new FileNotFoundError();
    if (mode === "write") await requireEditableAccount(actor, accountId);
    else if (!(await getAccount(actor, accountId))) throw new FileNotFoundError();
    return;
  }
  // Contract documents carry pricing terms: revenue access plus the account in the book.
  requirePermission(actor, "revenue:view");
  if (!accountId) throw new FileNotFoundError();
  if (mode === "write") await requireEditableAccount(actor, accountId);
  else if (!(await getAccount(actor, accountId))) throw new FileNotFoundError();
}

/** A missing or unavailable scanner leaves the file PENDING; only a real verdict sets CLEAN. */
async function scanOrPending(
  scanner: MalwareScanner | null,
  bytes: Uint8Array,
): Promise<"CLEAN" | "REJECTED" | "PENDING"> {
  if (!scanner) return "PENDING";
  try {
    return await scanner.scan(bytes);
  } catch (e) {
    if (e instanceof ScannerUnavailableError) return "PENDING";
    throw e;
  }
}

export async function storeUpload(
  actor: Actor,
  input: {
    purpose: UploadPurpose;
    accountId?: string | null;
    contractId?: string | null;
    filename: string;
    bytes: Uint8Array;
  },
  deps: FileDeps = {},
) {
  const accountId = input.accountId ?? null;
  await authorize(actor, input.purpose, accountId, "write");
  const check = await validateUpload({
    filename: input.filename,
    bytes: input.bytes,
    purpose: input.purpose,
  });
  if (!check.ok) throw new UploadRejectedError(check.error);

  const db = scopedDb(actor);
  if (input.contractId) {
    const contract = await db.contract.findFirst({
      where: { id: input.contractId, accountId: accountId ?? undefined },
    });
    if (!contract) throw new FileNotFoundError();
  }
  const scanner = deps.scanner === undefined ? getScanner() : deps.scanner;
  const scanStatus = await scanOrPending(scanner, input.bytes);
  if (scanStatus === "REJECTED")
    throw new UploadRejectedError("This file failed the security scan and was not uploaded.");

  const storage = storageWithBucket(deps.storage);
  await bucketReady;
  const objectId = randomUUID().replaceAll("-", "");
  const { key } = await storage.put(actor, ["files", objectId], input.bytes, check.mime);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  return db.$tenantTransaction(async (tx) => {
    const file = await tx.fileObject.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId,
        purpose: input.purpose,
        storageKey: key,
        filename: check.safeName,
        mimeType: check.mime,
        sizeBytes: input.bytes.byteLength,
        sha256,
        scanStatus,
        uploadedByMembershipId: actor.membershipId,
      },
    });
    if (input.contractId)
      await tx.contract.update({
        where: { id: input.contractId },
        data: { documentFileId: file.id },
      });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "file.uploaded",
        targetType: "FileObject",
        targetId: file.id,
        summary: `Uploaded ${check.safeName}`,
        after: {
          purpose: input.purpose,
          accountId,
          sizeBytes: input.bytes.byteLength,
          scanStatus,
          scanner: scanner?.name ?? "none",
        },
      },
      tx,
    );
    return file;
  });
}

export async function readFile(actor: Actor, fileId: string, deps: FileDeps = {}) {
  const file = await scopedDb(actor).fileObject.findUnique({ where: { id: fileId } });
  if (!file) throw new FileNotFoundError();
  await authorize(actor, file.purpose, file.accountId, "read", file);
  if (file.scanStatus !== "CLEAN") throw new FileNotReadyError();
  // Defence in depth: the stored key must sit under this workspace's prefix.
  const prefix = `ws/${actor.workspaceId}/`;
  if (!file.storageKey.startsWith(prefix)) throw new FileNotFoundError();
  const bytes = await storageWithBucket(deps.storage).get(
    actor,
    file.storageKey.slice(prefix.length).split("/"),
  );
  if (file.purpose === "CONTRACT_DOCUMENT") {
    await writeAudit({
      workspaceId: actor.workspaceId,
      actorType: "USER",
      actorId: actor.userId,
      action: "file.downloaded",
      targetType: "FileObject",
      targetId: file.id,
      summary: `Downloaded ${file.filename}`,
    });
  }
  return { filename: file.filename, mimeType: file.mimeType, bytes };
}

/** Contract documents on an account (members with revenue access only). */
export async function listContractDocuments(actor: Actor, accountId: string) {
  if (!can(actor, "revenue:view")) return [];
  if (!(await getAccount(actor, accountId))) throw new FileNotFoundError();
  return scopedDb(actor).fileObject.findMany({
    where: { accountId, purpose: "CONTRACT_DOCUMENT" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      filename: true,
      sizeBytes: true,
      createdAt: true,
      scanStatus: true,
      contracts: { select: { id: true } },
    },
  });
}

export { ForbiddenError };
