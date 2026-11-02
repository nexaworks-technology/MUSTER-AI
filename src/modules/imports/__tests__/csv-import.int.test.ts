import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import {
  confirmImport,
  getImport,
  previewImport,
  runImportJob,
  startImport,
  type ImportKind,
} from "../service";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(path.join(process.cwd(), "fixtures/csv", name)));

/** Adds the fixture owners (leo@, aisha@larkspur.test) as CSMs of a test workspace. */
async function withOwners(actor: Actor) {
  const db = scopedDb(actor);
  for (const email of ["leo@larkspur.test", "aisha@larkspur.test"]) {
    const user = await rawDb.user.upsert({
      where: { email },
      create: { email, name: email.split("@")[0] },
      update: {},
    });
    await db.membership.upsert({
      where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId: user.id } },
      create: { workspaceId: actor.workspaceId, userId: user.id, role: "CSM" },
      update: { status: "ACTIVE" },
    });
  }
}

async function importFile(actor: Actor, kind: ImportKind, file: string) {
  const job = await startImport(actor, kind, { filename: file, bytes: fixture(file) });
  const preview = await previewImport(actor, job.id);
  await confirmImport(actor, job.id);
  await runImportJob(actor.workspaceId, job.id);
  return { preview, result: await getImport(actor, job.id) };
}

const ORDER: Array<[ImportKind, string, number]> = [
  ["ACCOUNTS", "accounts-clean.csv", 3],
  ["CONTACTS", "contacts-clean.csv", 3],
  ["CONTRACTS", "contracts-clean.csv", 2],
  ["INVOICES", "invoices-clean.csv", 2],
  ["USAGE_ACCOUNT_DAILY", "usage-account-daily-clean.csv", 3],
  ["USAGE_USER_DAILY", "usage-user-daily-clean.csv", 2],
  ["USAGE_FEATURE_DAILY", "usage-feature-daily-clean.csv", 2],
  ["TICKETS", "tickets-clean.csv", 2],
  ["TICKET_MESSAGES", "ticket-messages-clean.csv", 2],
];

let a: Actor;

beforeAll(async () => {
  a = (await createTestAdmin("ImportA")).actor;
  await withOwners(a);
});

describe("CSV import", () => {
  it("imports every template, and importing each file again creates nothing (idempotent)", async () => {
    for (const [kind, file, rows] of ORDER) {
      const first = await importFile(a, kind, file);
      expect({
        kind,
        status: first.result.status,
        created: first.result.created,
        failed: first.result.failed,
      }).toEqual({ kind, status: "COMPLETED", created: rows, failed: 0 });
    }
    for (const [kind, file, rows] of ORDER) {
      const again = await importFile(a, kind, file);
      expect({
        kind,
        created: again.result.created,
        updated: again.result.updated,
        unchanged: again.result.unchanged,
      }).toEqual({ kind, created: 0, updated: 0, unchanged: rows });
    }
    const db = scopedDb(a);
    expect(await db.account.count({ where: { source: "CSV" } })).toBe(3);
    expect(await db.contact.count({ where: { source: "CSV" } })).toBe(3);
    // Contracts drove ARR, renewal and tier through the same rules as manual entry.
    const bramble = await db.account.findFirstOrThrow({ where: { name: "Bramble Health" } });
    expect(bramble.arrMinor).toBe(9_600_000n);
    expect(bramble.renewalDate?.toISOString().slice(0, 10)).toBe("2027-01-15");
    expect(await db.ticket.count({ where: { source: "CSV" } })).toBe(2);
    expect(await db.message.count({ where: { source: "CSV" } })).toBe(2);
  });

  it("the preview is a dry run: it writes nothing to the Account Graph", async () => {
    const fresh = (await createTestAdmin("ImportDry")).actor;
    await withOwners(fresh);
    const job = await startImport(fresh, "ACCOUNTS", {
      filename: "accounts-clean.csv",
      bytes: fixture("accounts-clean.csv"),
    });
    const preview = await previewImport(fresh, job.id);
    expect(preview.preview).toMatchObject({ create: 3, update: 0, unchanged: 0, fail: 0 });
    const db = scopedDb(fresh);
    expect(await db.account.count()).toBe(0);
    expect(await db.externalRef.count()).toBe(0);
  });

  it("reports every malformed row in plain words, imports only the good row, and audits the run", async () => {
    const { preview, result } = await importFile(a, "ACCOUNTS", "accounts-malformed.csv");
    expect(preview.errors.map((e) => e.message)).toEqual([
      "Row 3: name is required.",
      "Row 4: tier 'Platinum' is not one of: High-touch, Mid-touch, Long-tail.",
      "Row 5: stage 'Sleeping' is not one of: Onboarding, Adopting, Mature, Renewing, Lost.",
      "Row 6: onboarding started '31/13/2026' is not a date (use YYYY-MM-DD, e.g. 2026-10-31).",
      "Row 7: account_id 'FX-10' is repeated (first used on row 2).",
      "Row 8: owner_email 'nobody@larkspur.test' is not an active admin, CS leader or CSM here.",
    ]);
    expect(result).toMatchObject({ status: "COMPLETED", created: 1, failed: 6 });
    expect(result.report?.errors).toHaveLength(6);
    const actions = (await scopedDb(a).auditLog.findMany({ where: { targetId: result.id } })).map(
      (x) => x.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        "import.uploaded",
        "import.confirmed",
        "import.chunk",
        "import.completed",
      ]),
    );
  });

  it("rejects files that are not plain-text CSV, before anything is stored", async () => {
    const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 0x00), Buffer.from(",x\n")]);
    await expect(
      startImport(a, "ACCOUNTS", { filename: "accounts.csv", bytes: exe }),
    ).rejects.toThrow(/plain-text CSV|couldn't be read/);
    const pdf = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n", "latin1");
    await expect(
      startImport(a, "ACCOUNTS", { filename: "accounts.csv", bytes: pdf }),
    ).rejects.toThrow(/plain-text CSV|couldn't be read/);
  });

  it("another workspace importing the same ids gets its own records and never touches the first", async () => {
    const b = (await createTestAdmin("ImportB")).actor;
    await withOwners(b);
    const before = await scopedDb(a).account.count();
    const { result } = await importFile(b, "ACCOUNTS", "accounts-clean.csv");
    expect(result.created).toBe(3);
    expect(await scopedDb(a).account.count()).toBe(before);
    const refsA = await scopedDb(a).externalRef.findMany({
      where: { objectType: "Account", externalId: "FX-1" },
    });
    const refsB = await scopedDb(b).externalRef.findMany({
      where: { objectType: "Account", externalId: "FX-1" },
    });
    expect(refsA).toHaveLength(1);
    expect(refsB).toHaveLength(1);
    expect(refsA[0]!.internalId).not.toBe(refsB[0]!.internalId);
  });

  it("a CSM cannot import", async () => {
    await expect(
      startImport({ ...a, role: "CSM" }, "ACCOUNTS", {
        filename: "a.csv",
        bytes: fixture("accounts-clean.csv"),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
