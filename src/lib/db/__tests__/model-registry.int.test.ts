import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { GLOBAL_MODELS, TENANT_MODELS } from "@/lib/db/tenantModels";

/**
 * Protects every future milestone: a new Prisma model must be classified, and a [W] model must
 * carry workspaceId, the composite unique, and RLS ENABLE + FORCE + tenant_isolation.
 */
const models = Prisma.dmmf.datamodel.models;
const tenant: readonly string[] = TENANT_MODELS;
const global: readonly string[] = GLOBAL_MODELS;

describe("model registry", () => {
  it("classifies every Prisma model exactly once", () => {
    for (const m of models) {
      const inTenant = tenant.includes(m.name);
      const inGlobal = global.includes(m.name);
      expect({ model: m.name, classified: inTenant !== inGlobal }).toEqual({
        model: m.name,
        classified: true,
      });
    }
    const names = models.map((m) => m.name);
    for (const n of [...tenant, ...global]) expect(names).toContain(n);
  });

  it.each(TENANT_MODELS)("%s has workspaceId and @@unique([workspaceId, id])", (name) => {
    const model = models.find((m) => m.name === name);
    expect(model?.fields.some((f) => f.name === "workspaceId" && f.isRequired)).toBe(true);
    expect(model?.uniqueFields).toContainEqual(["workspaceId", "id"]);
  });

  it.each(TENANT_MODELS)(
    "%s has RLS enabled, forced and a tenant_isolation policy",
    async (name) => {
      const [rls] = await rawDb.$queryRaw<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class WHERE relname = ${name} AND relkind = 'r'`;
      expect(rls).toEqual({ enabled: true, forced: true });
      const policies = await rawDb.$queryRaw<{ policyname: string }[]>`
      SELECT policyname FROM pg_policies WHERE tablename = ${name}`;
      expect(policies.map((p) => p.policyname)).toContain("tenant_isolation");
    },
  );

  it("the runtime role cannot bypass RLS", async () => {
    const [role] = await rawDb.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("every model that can hold AI output enforces origin = AI ⇒ agentRunId (Rule 5)", async () => {
    const aiCapable = models.filter((m) =>
      ["origin", "agentRunId"].every((f) => m.fields.some((x) => x.name === f)),
    );
    expect(aiCapable.length).toBeGreaterThan(0);
    for (const m of aiCapable) {
      const rows = await rawDb.$queryRaw<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = ${`"${m.name}"`}::regclass AND contype = 'c' AND conname LIKE '%agent_run_required'`;
      expect({ model: m.name, checks: rows.length }).toEqual({ model: m.name, checks: 1 });
    }
  });
});
