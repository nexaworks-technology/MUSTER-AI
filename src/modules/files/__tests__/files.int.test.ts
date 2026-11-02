import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { env } from "@/lib/config/env";
import { scopedDb } from "@/lib/db/scoped";
import { createStorage, type Storage } from "@/lib/storage";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import {
  FileNotFoundError,
  FileNotReadyError,
  readFile,
  storeUpload,
  UploadRejectedError,
} from "../service";

/** Real MinIO storage (test bucket) wrapped to count writes, so we can prove rejects never land. */
function spyStorage(): Storage & { puts: number } {
  const e = env();
  const real = createStorage({
    endpoint: e.S3_ENDPOINT,
    region: e.S3_REGION,
    bucket: e.S3_BUCKET,
    accessKeyId: e.S3_ACCESS_KEY_ID,
    secretAccessKey: e.S3_SECRET_ACCESS_KEY,
  });
  const spy = {
    ...real,
    puts: 0,
    put: async (...args: Parameters<Storage["put"]>) => {
      spy.puts++;
      return real.put(...args);
    },
  };
  return spy;
}

const pdf = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n", "latin1");
let a: Actor;
let b: Actor;
let accountId: string;
let contractId: string;
let storage: ReturnType<typeof spyStorage>;

beforeAll(async () => {
  storage = spyStorage();
  await storage.ensureBucket();
  a = (await createTestAdmin("FilesA")).actor;
  b = (await createTestAdmin("FilesB")).actor;
  const db = scopedDb(a);
  accountId = (
    await db.account.create({
      data: {
        workspaceId: a.workspaceId,
        name: "Docs Co",
        tier: "MID_TOUCH",
        ownerMembershipId: a.membershipId,
      },
    })
  ).id;
  contractId = (
    await db.contract.create({
      data: { workspaceId: a.workspaceId, accountId, startDate: new Date("2026-01-01") },
    })
  ).id;
});

describe("upload safety", () => {
  it("stores a contract document under a key we generate, scoped to the workspace, and links it", async () => {
    const file = await storeUpload(
      a,
      {
        purpose: "CONTRACT_DOCUMENT",
        accountId,
        contractId,
        filename: "../../Signed contract.pdf",
        bytes: pdf,
      },
      { storage },
    );
    expect(file.storageKey).toMatch(new RegExp(`^ws/${a.workspaceId}/files/[0-9a-f]{32}$`));
    expect(file.storageKey).not.toContain("Signed");
    expect(file).toMatchObject({
      filename: "Signed contract.pdf",
      mimeType: "application/pdf",
      scanStatus: "CLEAN",
    });
    const contract = await scopedDb(a).contract.findUniqueOrThrow({ where: { id: contractId } });
    expect(contract.documentFileId).toBe(file.id);
    const read = await readFile(a, file.id, { storage });
    expect(Buffer.from(read.bytes).equals(pdf)).toBe(true);
  });

  it("a rejected file never reaches storage", async () => {
    const before = storage.puts;
    await expect(
      storeUpload(
        a,
        {
          purpose: "CONTRACT_DOCUMENT",
          accountId,
          filename: "invoice.pdf",
          bytes: Buffer.from("MZ not really a pdf"),
        },
        { storage },
      ),
    ).rejects.toBeInstanceOf(UploadRejectedError);
    await expect(
      storeUpload(
        a,
        { purpose: "CSV_IMPORT", filename: "x.exe", bytes: Buffer.from("MZ") },
        { storage },
      ),
    ).rejects.toBeInstanceOf(UploadRejectedError);
    expect(storage.puts).toBe(before);
  });

  it("another workspace cannot download the file by id, or by its storage key", async () => {
    const file = await storeUpload(
      a,
      { purpose: "CONTRACT_DOCUMENT", accountId, filename: "c.pdf", bytes: pdf },
      { storage },
    );
    await expect(readFile(b, file.id, { storage })).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(readFile(b, file.storageKey, { storage })).rejects.toBeInstanceOf(
      FileNotFoundError,
    );
    // Even a direct storage read through B's key builder lands under B's prefix, not A's.
    await expect(storage.get(b, file.storageKey.split("/").slice(2))).rejects.toThrow();
  });

  it("contract documents need revenue access to upload or download", async () => {
    const file = await storeUpload(
      a,
      { purpose: "CONTRACT_DOCUMENT", accountId, filename: "d.pdf", bytes: pdf },
      { storage },
    );
    const csm = { ...a, role: "CSM" as const, canViewRevenue: false };
    await expect(readFile(csm, file.id, { storage })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      storeUpload(
        csm,
        { purpose: "CONTRACT_DOCUMENT", accountId, filename: "e.pdf", bytes: pdf },
        { storage },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("CSV imports are for Admins and CS Leaders only", async () => {
    await expect(
      storeUpload(
        { ...a, role: "CSM" },
        { purpose: "CSV_IMPORT", filename: "a.csv", bytes: Buffer.from("a,b\n") },
        { storage },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("without a configured scanner (production) a file stays pending and cannot be opened", async () => {
    const file = await storeUpload(
      a,
      { purpose: "CONTRACT_DOCUMENT", accountId, filename: "f.pdf", bytes: pdf },
      { storage, scanner: null },
    );
    expect(file.scanStatus).toBe("PENDING");
    await expect(readFile(a, file.id, { storage })).rejects.toBeInstanceOf(FileNotReadyError);
  });

  it("a file the scanner rejects is not stored", async () => {
    const before = storage.puts;
    await expect(
      storeUpload(
        a,
        { purpose: "CONTRACT_DOCUMENT", accountId, filename: "g.pdf", bytes: pdf },
        { storage, scanner: { name: "test", scan: async () => "REJECTED" } },
      ),
    ).rejects.toThrow(/security scan/);
    expect(storage.puts).toBe(before);
  });
});
