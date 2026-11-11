import { Prisma } from "@prisma/client";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { fieldCipher } from "@/lib/crypto";
import { scopedDb } from "@/lib/db/scoped";
import { TENANT_MODELS } from "@/lib/db/tenantModels";
import { getQueue } from "@/lib/jobs/queues";
import { getStorage } from "@/lib/storage";
import { createTestAdmin, createTestWorkspace } from "@/test/fixtures";
import {
  EXCLUDED_COLUMNS,
  EXPORT_LINK_TTL_SECONDS,
  getExportLink,
  listExports,
  requestExport,
  runExportJob,
} from "../data-controls/export";
import { importExport } from "./export-import.helper";
import type { Actor } from "../service";

/**
 * M12 B1: the data export. Runs the job inline against the local Postgres and MinIO, unzips the
 * result, re-imports the JSON into a scratch workspace (test-only importer) and compares counts.
 */
const cipher = fieldCipher();
const TERMS = "Net 30; 12-month term; termination on 60 days notice";
const jobIds: string[] = [];

afterAll(async () => {
  for (const id of jobIds) await getQueue("maintenance").remove(id);
});

async function seed(label: string) {
  const { actor, membership } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const w = actor.workspaceId;
  const accounts = [];
  for (const n of [1, 2]) {
    accounts.push(
      await db.account.create({
        data: {
          workspaceId: w,
          name: `${label} account ${n}`,
          tier: "HIGH_TOUCH",
          arrMinor: BigInt(120_000_00) * BigInt(n),
          arrCurrency: "USD",
          ownerMembershipId: membership.id,
        },
      }),
    );
  }
  const acct = accounts[0]!;
  const contact = await db.contact.create({
    data: { workspaceId: w, accountId: acct.id, name: `${label} Contact`, email: "c@example.test" },
  });
  await db.contact.create({ data: { workspaceId: w, accountId: accounts[1]!.id, name: "Second" } });
  await db.contract.create({
    data: {
      workspaceId: w,
      accountId: acct.id,
      startDate: new Date("2026-01-01"),
      valueMinor: 120_000_00n,
      termsEnc: cipher.encrypt(TERMS),
      pricingNotesEnc: cipher.encrypt("Discount 10% year one"),
    },
  });
  const signal = await db.signal.create({
    data: {
      workspaceId: w,
      accountId: acct.id,
      ruleKey: "usage.drop",
      ruleVersion: 1,
      category: "USAGE",
      severity: "WARN",
      polarity: "RISK",
      title: "Usage fell",
      explanation: "Weekly actives fell 40%",
      evidence: [{ table: "UsageDaily", note: "Weekly actives 120 to 72" }],
      values: {},
      params: {},
      dedupeKey: `${label}-usage`,
      firstSeenAt: new Date("2026-10-01"),
      lastSeenAt: new Date("2026-10-02"),
    },
  });
  await db.task.create({
    data: { workspaceId: w, accountId: acct.id, signalId: signal.id, title: "Call them" },
  });
  await db.approval.create({
    data: {
      workspaceId: w,
      accountId: acct.id,
      signalId: signal.id,
      kind: "SEND_EMAIL",
      reason: "Check in",
      requiredLevel: "DRAFT_FOR_APPROVAL",
    },
  });
  await db.note.create({
    data: { workspaceId: w, accountId: acct.id, body: `${label} note`, tags: ["qbr"] },
  });
  await db.invitation.create({
    data: {
      workspaceId: w,
      email: `inv-${w}@example.test`,
      role: "CSM",
      tokenHash: `hash-${w}-SECRET-INVITE`,
      expiresAt: new Date("2026-12-01"),
      invitedByMembershipId: membership.id,
    },
  });
  await db.portalAccess.create({
    data: {
      workspaceId: w,
      accountId: acct.id,
      contactId: contact.id,
      tokenHash: `hash-${w}-SECRET-PORTAL`,
      expiresAt: new Date("2026-12-01"),
    },
  });
  await db.integration.create({
    data: {
      workspaceId: w,
      provider: "USAGE_API",
      credentialsEnc: cipher.encrypt(`{"apiKey":"sk-${w}-SECRET-CRED"}`),
      ingestKeyHash: `ingest-${w}-SECRET-HASH`,
      ingestKeyLast4: "abcd",
    },
  });
  const storage = getStorage();
  await storage.ensureBucket();
  const fileBody = `file body for ${label}`;
  await storage.put({ workspaceId: w }, ["files", `${label}.txt`], fileBody, "text/plain");
  await db.fileObject.create({
    data: {
      workspaceId: w,
      accountId: acct.id,
      purpose: "CONTRACT_DOCUMENT",
      storageKey: `ws/${w}/files/${label}.txt`,
      filename: `${label}.txt`,
      mimeType: "text/plain",
      sizeBytes: fileBody.length,
      sha256: "0".repeat(64),
      scanStatus: "CLEAN",
    },
  });
  return { actor, acct, fileBody };
}

async function exportZip(actor: Actor) {
  const { requestId, jobId } = await requestExport(actor);
  jobIds.push(jobId);
  await runExportJob({
    workspaceId: actor.workspaceId,
    requestId,
    requestedByMembershipId: actor.membershipId,
  });
  const link = await getExportLink(actor, requestId);
  const res = await fetch(link.url);
  expect(res.status).toBe(200);
  const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
  return { requestId, link, zip };
}

const json = (zip: Record<string, Uint8Array>, name: string) =>
  JSON.parse(strFromU8(zip[name]!)) as unknown;

describe("workspace export", () => {
  it("round-trips per-entity counts, keeps tenants apart and leaves credentials out", async () => {
    const a = await seed("ExpA");
    const b = await seed("ExpB");
    const { zip, requestId } = await exportZip(a.actor);

    const manifest = json(zip, "manifest.json") as {
      workspace: { id: string };
      counts: Record<string, number>;
      excludedColumns: Array<{ model: string; column: string; reason: string }>;
      notes: string[];
      files: { count: number };
    };
    expect(manifest.workspace.id).toBe(a.actor.workspaceId);
    expect(Object.keys(manifest.counts).sort()).toEqual([...TENANT_MODELS].sort());
    expect(manifest.counts.Account).toBe(2);
    expect(manifest.counts.Contact).toBe(2);
    expect(manifest.files.count).toBe(1);
    expect(manifest.notes.join(" ")).toMatch(/money|financial/i);
    expect(manifest.excludedColumns.map((c) => `${c.model}.${c.column}`)).toEqual(
      expect.arrayContaining([
        "Integration.credentialsEnc",
        "Integration.ingestKeyHash",
        "Invitation.tokenHash",
        "PortalAccess.tokenHash",
      ]),
    );
    expect(manifest.excludedColumns.every((c) => c.reason.length > 10)).toBe(true);

    // One JSON file per [W] model, each the length the manifest says.
    const data: Record<string, Array<Record<string, unknown>>> = {};
    for (const model of TENANT_MODELS) {
      data[model] = json(zip, `data/${model}.json`) as Array<Record<string, unknown>>;
      expect(data[model]).toHaveLength(manifest.counts[model]!);
    }
    // BigInt as string, dates as ISO, contract terms decrypted.
    expect(data.Account!.map((r) => r.arrMinor).sort()).toEqual(["12000000", "24000000"]);
    expect(String(data.Account![0]!.createdAt)).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(data.Contract![0]!.terms).toBe(TERMS);
    expect(data.Contract![0]).not.toHaveProperty("termsEnc");

    // Files from storage.
    const fileKey = Object.keys(zip).find((k) => k.startsWith("files/"))!;
    expect(strFromU8(zip[fileKey]!)).toBe(a.fileBody);

    // No credential material, no other tenant.
    const everything = Object.values(zip)
      .map((u) => strFromU8(u))
      .join("\n");
    for (const secret of [
      `${a.actor.workspaceId}-SECRET-INVITE`,
      `${a.actor.workspaceId}-SECRET-PORTAL`,
      `${a.actor.workspaceId}-SECRET-CRED`,
      `${a.actor.workspaceId}-SECRET-HASH`,
    ])
      expect(everything).not.toContain(secret);
    for (const m of EXCLUDED_COLUMNS)
      for (const r of data[m.model]!) expect(r).not.toHaveProperty(m.column);
    expect(everything).not.toContain("ExpB");
    expect(everything).not.toContain(b.actor.workspaceId);
    expect(everything).not.toContain(b.fileBody);

    // Round trip into a scratch workspace.
    const { workspace: scratch } = await createTestWorkspace("Scratch");
    const imported = await importExport(
      Object.fromEntries(TENANT_MODELS.map((m) => [m, data[m]])),
      scratch.id,
    );
    const db = scopedDb({ workspaceId: scratch.id }) as unknown as Record<
      string,
      { count: () => Promise<number> }
    >;
    for (const model of TENANT_MODELS) {
      const delegate = model.charAt(0).toLowerCase() + model.slice(1);
      expect(await db[delegate]!.count(), model).toBe(manifest.counts[model]);
      expect(imported.counts[model]).toBe(manifest.counts[model]);
    }
    const contract = await scopedDb({ workspaceId: scratch.id }).contract.findFirstOrThrow();
    expect(cipher.decrypt(contract.termsEnc!)).toBe(TERMS);

    // Audit trail: requested, then ready, both naming the request.
    const audit = await scopedDb(a.actor).auditLog.findMany({
      where: { action: { startsWith: "data.export_" } },
      orderBy: { createdAt: "asc" },
    });
    expect(audit.map((r) => r.action)).toEqual(["data.export_requested", "data.export_ready"]);
    expect(JSON.stringify(audit)).toContain(requestId);
    expect(JSON.stringify(audit)).not.toContain("X-Amz-Signature");
  }, 120_000);

  it("signs a 7-day link that stops being offered once it has expired", async () => {
    const { actor } = await seed("ExpLink");
    const { requestId, link } = await exportZip(actor);
    expect(EXPORT_LINK_TTL_SECONDS).toBe(7 * 86_400);
    const url = new URL(link.url);
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeGreaterThan(7 * 86_400 - 120);
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(7 * 86_400);
    expect(url.searchParams.get("response-content-disposition")).toMatch(/^attachment/);
    const days = (link.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
    const later = new Date(Date.now() + 8 * 86_400_000);
    await expect(getExportLink(actor, requestId, later)).rejects.toThrow(/expired/i);
    const rows = await listExports(actor, later);
    expect(rows[0]).toMatchObject({ requestId, status: "expired" });
    expect((await listExports(actor))[0]).toMatchObject({ requestId, status: "ready" });
  }, 120_000);

  it("allows one running export per workspace and a new one after it finishes", async () => {
    const { actor } = await createTestAdmin("ExpOne");
    const first = await requestExport(actor);
    jobIds.push(first.jobId);
    await expect(requestExport(actor)).rejects.toThrow(/already running/i);
    await runExportJob({
      workspaceId: actor.workspaceId,
      requestId: first.requestId,
      requestedByMembershipId: actor.membershipId,
    });
    const second = await requestExport(actor);
    jobIds.push(second.jobId);
    expect(second.requestId).not.toBe(first.requestId);
    expect(await getQueue("maintenance").getJob(second.jobId)).toBeTruthy();
  }, 60_000);

  it("records a failure and frees the workspace for another try", async () => {
    const { actor } = await createTestAdmin("ExpFail");
    const { requestId, jobId } = await requestExport(actor);
    jobIds.push(jobId);
    await expect(
      runExportJob(
        { workspaceId: actor.workspaceId, requestId, requestedByMembershipId: actor.membershipId },
        {
          afterBuild: () => {
            throw new Error("storage down");
          },
        },
      ),
    ).rejects.toThrow("storage down");
    expect((await listExports(actor))[0]).toMatchObject({ requestId, status: "failed" });
    jobIds.push((await requestExport(actor)).jobId);
  }, 60_000);

  it("is Admin only, for requesting, listing and downloading", async () => {
    const { actor } = await createTestAdmin("ExpPerm");
    const { requestId, jobId } = await requestExport(actor);
    jobIds.push(jobId);
    await runExportJob({
      workspaceId: actor.workspaceId,
      requestId,
      requestedByMembershipId: actor.membershipId,
    });
    for (const role of ["CS_LEADER", "CSM", "VIEWER"] as const) {
      const other: Actor = { ...actor, role };
      await expect(requestExport(other)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listExports(other)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getExportLink(other, requestId)).rejects.toBeInstanceOf(ForbiddenError);
    }
  }, 60_000);

  it("cannot download another workspace's export", async () => {
    const a = await createTestAdmin("ExpXa");
    const b = await createTestAdmin("ExpXb");
    const { requestId, jobId } = await requestExport(a.actor);
    jobIds.push(jobId);
    await runExportJob({
      workspaceId: a.actor.workspaceId,
      requestId,
      requestedByMembershipId: a.actor.membershipId,
    });
    await expect(getExportLink(b.actor, requestId)).rejects.toThrow(/not found/i);
  }, 60_000);

  it("names every sensitive-looking or encrypted column: exported plain, or excluded with a reason", () => {
    const allowed = new Set([
      "HealthScoreSnapshot.inputsHash",
      "ReportSnapshot.filtersHash",
      "AgentRun.inputTokens",
      "AgentRun.outputTokens",
      // AI cost session: token counts and a hash of the (non-secret) run input; exported plain.
      "AgentRun.cacheReadTokens",
      "AgentRun.cacheCreationTokens",
      "AgentRun.planningInputTokens",
      "AgentRun.planningOutputTokens",
      "AgentRun.inputHash",
    ]);
    const excluded = new Set(EXCLUDED_COLUMNS.map((c) => `${c.model}.${c.column}`));
    const unnamed: string[] = [];
    for (const model of Prisma.dmmf.datamodel.models) {
      if (!(TENANT_MODELS as readonly string[]).includes(model.name)) continue;
      for (const f of model.fields) {
        const key = `${model.name}.${f.name}`;
        if (
          /hash|token|secret|credential|password|enc$/i.test(f.name) &&
          !excluded.has(key) &&
          !allowed.has(key)
        )
          unnamed.push(key);
      }
    }
    // Contract.termsEnc / pricingNotesEnc are the only field-encrypted columns exported (decrypted).
    expect(unnamed.sort()).toEqual(["Contract.pricingNotesEnc", "Contract.termsEnc"]);
  });
});
