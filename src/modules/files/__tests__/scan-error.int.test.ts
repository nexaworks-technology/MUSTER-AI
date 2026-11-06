import { beforeAll, describe, expect, it } from "vitest";
import { env } from "@/lib/config/env";
import { scopedDb } from "@/lib/db/scoped";
import { createStorage } from "@/lib/storage";
import { ScannerUnavailableError } from "@/lib/uploads/clamd";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { FileNotReadyError, readFile, storeUpload } from "../service";

const pdf = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n", "latin1");
let a: Actor;
let accountId: string;

function storage() {
  const e = env();
  return createStorage({
    endpoint: e.S3_ENDPOINT,
    region: e.S3_REGION,
    bucket: e.S3_BUCKET,
    accessKeyId: e.S3_ACCESS_KEY_ID,
    secretAccessKey: e.S3_SECRET_ACCESS_KEY,
  });
}

beforeAll(async () => {
  await storage().ensureBucket();
  a = (await createTestAdmin("ScanErr")).actor;
  accountId = (
    await scopedDb(a).account.create({
      data: {
        workspaceId: a.workspaceId,
        name: "Scan Co",
        tier: "MID_TOUCH",
        ownerMembershipId: a.membershipId,
      },
    })
  ).id;
});

describe("scanner errors never mark a file clean", () => {
  it("an unavailable scanner leaves the file PENDING and unreadable", async () => {
    const s = storage();
    const scanner = {
      name: "down",
      scan: async () => {
        throw new ScannerUnavailableError("clamd is down");
      },
    };
    const file = await storeUpload(
      a,
      { purpose: "CONTRACT_DOCUMENT", accountId, filename: "h.pdf", bytes: pdf },
      { storage: s, scanner },
    );
    expect(file.scanStatus).toBe("PENDING");
    await expect(readFile(a, file.id, { storage: s })).rejects.toBeInstanceOf(FileNotReadyError);
  });

  it("an unexpected scanner failure is not swallowed into CLEAN", async () => {
    await expect(
      storeUpload(
        a,
        { purpose: "CONTRACT_DOCUMENT", accountId, filename: "i.pdf", bytes: pdf },
        {
          storage: storage(),
          scanner: {
            name: "bug",
            scan: async () => {
              throw new Error("boom");
            },
          },
        },
      ),
    ).rejects.toThrow("boom");
  });
});
