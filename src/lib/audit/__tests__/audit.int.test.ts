import { describe, expect, it } from "vitest";
import { redact, writeAudit } from "@/lib/audit";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestWorkspace } from "@/test/fixtures";

/** Rule 5 base: every audit row persists, cannot be changed, and never holds secrets. */
describe("audit log", () => {
  it("writes a row scoped to the workspace", async () => {
    const { workspace, user } = await createTestWorkspace("Audit");
    const row = await writeAudit({
      workspaceId: workspace.id,
      actorType: "USER",
      actorId: user.id,
      action: "test.written",
      targetType: "User",
      targetId: user.id,
      summary: "Test entry",
    });
    const found = await scopedDb({ workspaceId: workspace.id }).auditLog.findUnique({
      where: { id: row.id },
    });
    expect(found).toMatchObject({ action: "test.written", actorType: "USER", targetId: user.id });
  });

  it("rejects UPDATE and DELETE (append-only trigger)", async () => {
    const { workspace } = await createTestWorkspace("AuditRO");
    const db = scopedDb({ workspaceId: workspace.id });
    const row = await writeAudit({
      workspaceId: workspace.id,
      actorType: "SYSTEM",
      action: "test.immutable",
      summary: "Cannot change",
    });
    await expect(
      db.auditLog.update({ where: { id: row.id }, data: { summary: "changed" } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(
      rawDb.$transaction([
        rawDb.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`,
        rawDb.$executeRaw`UPDATE "AuditLog" SET summary = 'x' WHERE id = ${row.id}`,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it("redacts secret-looking keys in before/after, recursively", async () => {
    const { workspace } = await createTestWorkspace("AuditRedact");
    const row = await writeAudit({
      workspaceId: workspace.id,
      actorType: "SYSTEM",
      action: "test.redacted",
      summary: "Redaction",
      before: { password: "hunter2", nested: { apiToken: "abc", clientSecret: "def", ok: 1 } },
      after: { list: [{ refresh_token: "zzz", name: "kept" }] },
    });
    const text = JSON.stringify([row.before, row.after]);
    for (const secret of ["hunter2", "abc", "def", "zzz"]) expect(text).not.toContain(secret);
    expect(row.before).toMatchObject({ nested: { ok: 1 } });
    expect(row.after).toMatchObject({ list: [{ name: "kept" }] });
  });

  it("redact() leaves ordinary values alone", () => {
    expect(redact({ role: "CSM", email: "a@b.test" })).toEqual({ role: "CSM", email: "a@b.test" });
  });
});
