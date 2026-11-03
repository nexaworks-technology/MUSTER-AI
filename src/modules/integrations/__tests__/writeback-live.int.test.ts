import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseEnv } from "@/lib/config/env";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import type { IntegrationAdapter } from "../adapter";
import { sealCredentials } from "../credentials";
import { describeProviderError } from "../errors";
import { createFixtureTransport } from "../fixture-transport";
import { createLiveTransport } from "../transport";
import { executeApprovedWriteBack, requestWriteBack, setWriteBack } from "../writeback.service";

/**
 * D-116 (founder, 2026-11-04): write-back stays fake-transport-only IN CODE. A push over the live
 * transport refuses unless WRITE_BACK_LIVE=true, and the refusal is audited like any gate refusal.
 * Fixture transports push as before. The live case runs at fake-HTTP level (no network): a fetch
 * stub behind the real live transport.
 */
function adapterWith(
  push: IntegrationAdapter<Record<string, never>>["writeBack"] extends infer W
    ? W extends { push: infer P }
      ? P
      : never
    : never,
) {
  const adapter: IntegrationAdapter<Record<string, never>> = {
    provider: "HUBSPOT",
    category: "CRM",
    displayName: "Fake HubSpot",
    configSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
    auth: { kind: "apiKey", validate: async () => {} },
    testConnection: async () => ({ ok: true, message: "ok" }),
    async *sync() {},
    writeBack: { fields: [{ key: "ownerMembershipId", label: "Account owner" }], push },
    describeError: (e) => describeProviderError(e, "HubSpot", "Reconnect HubSpot."),
  };
  return adapter as IntegrationAdapter<unknown>;
}

const pusher = () =>
  vi.fn(
    async (
      ctx: { transport: ReturnType<typeof createLiveTransport> },
      c: { externalId: string; value: string },
    ) => {
      const res = await ctx.transport.request({
        method: "PATCH",
        url: `https://api.hubapi.test/crm/v3/objects/companies/${c.externalId}`,
        body: JSON.stringify({ properties: { hubspot_owner_id: c.value } }),
      });
      if (res.status !== 200) throw new Error("push failed");
    },
  );

async function approvedWriteBack(
  label: string,
  deps: { adapter: () => IntegrationAdapter<unknown>; transport: () => never },
) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const integration = await db.integration.create({
    data: {
      workspaceId: ws,
      provider: "HUBSPOT",
      credentialsEnc: sealCredentials({ apiKey: "k-test" }),
    },
  });
  const account = await db.account.create({
    data: { workspaceId: ws, name: `${label} Co`, tier: "MID_TOUCH", source: "HUBSPOT" },
  });
  const ref = (objectType: string, externalId: string, internalId: string) => ({
    workspaceId: ws,
    integrationId: integration.id,
    source: "HUBSPOT" as const,
    objectType,
    externalId,
    internalType: objectType === "Owner" ? "Membership" : "Account",
    internalId,
  });
  await db.externalRef.createMany({
    data: [ref("Account", "hs-co-1", account.id), ref("Owner", "hs-owner-9", actor.membershipId)],
  });
  await setWriteBack(actor, integration.id, { enabled: true, fields: ["ownerMembershipId"] }, deps);
  const r = await requestWriteBack(
    actor,
    integration.id,
    { field: "ownerMembershipId", accountId: account.id, value: actor.membershipId },
    deps,
  );
  await db.approval.update({
    where: { id: r.approvalId },
    data: {
      status: "APPROVED",
      decidedById: actor.membershipId,
      decidedAt: new Date(),
      decidedVia: "APP",
    },
  });
  const actions = async () =>
    (
      await db.auditLog.findMany({
        where: { targetId: integration.id },
        orderBy: { createdAt: "asc" },
      })
    ).map((a) => a.action);
  return { actor, db, integration, approvalId: r.approvalId, actions };
}

const okFetch = () =>
  vi.fn(
    async () =>
      new Response(JSON.stringify({ id: "hs-co-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );

describe("write-back over a live transport (D-116)", () => {
  it("a fixture transport still pushes through the gate (control)", async () => {
    const push = pusher();
    const fixture = createFixtureTransport([
      {
        request: { method: "PATCH", path: "/crm/v3/objects/companies/hs-co-1" },
        response: { status: 200, headers: {}, body: {} },
      },
    ]);
    const deps = { adapter: () => adapterWith(push as never), transport: () => fixture as never };
    const S = await approvedWriteBack("WbxFixture", deps);
    const out = await executeApprovedWriteBack(S.actor, S.approvalId, deps);
    expect(out.status).toBe("PUSHED");
    expect(push).toHaveBeenCalledOnce();
    expect(fixture.unmatched).toEqual([]);
  });

  it("a live transport refuses with WRITE_BACK_LIVE unset: nothing sent, audited, approval untouched", async () => {
    expect(process.env.WRITE_BACK_LIVE).toBeUndefined(); // the default under test
    const push = pusher();
    const fetchStub = okFetch();
    const live = createLiveTransport(fetchStub as never);
    const deps = { adapter: () => adapterWith(push as never), transport: () => live as never };
    const S = await approvedWriteBack("WbxLiveOff", deps);
    const out = await executeApprovedWriteBack(S.actor, S.approvalId, deps);
    expect(out.status).toBe("REFUSED");
    expect(out.plain).toMatch(/WRITE_BACK_LIVE is not set.*nothing was changed there/);
    expect(push).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await S.actions()).toEqual([
      "integration.writeback_changed",
      "integration.writeback_requested",
      "integration.writeback_refused",
    ]);
    const refusal = await S.db.auditLog.findFirstOrThrow({
      where: { action: "integration.writeback_refused" },
    });
    expect(refusal.summary).toContain(S.approvalId);
    expect(JSON.stringify(refusal.after)).toContain('"transport":"live"');
    expect((await S.db.approval.findUniqueOrThrow({ where: { id: S.approvalId } })).status).toBe(
      "APPROVED",
    );
  });

  it("with WRITE_BACK_LIVE on, the same live push proceeds (fake HTTP): one PATCH, audited as pushed", async () => {
    const push = pusher();
    const fetchStub = okFetch();
    const live = createLiveTransport(fetchStub as never);
    const deps = {
      adapter: () => adapterWith(push as never),
      transport: () => live as never,
      writeBackLive: true,
    };
    const S = await approvedWriteBack("WbxLiveOn", deps);
    const out = await executeApprovedWriteBack(S.actor, S.approvalId, deps);
    expect(out.status).toBe("PUSHED");
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(fetchStub.mock.calls[0]).toEqual([
      "https://api.hubapi.test/crm/v3/objects/companies/hs-co-1",
      expect.objectContaining({ method: "PATCH" }),
    ]);
    expect((await S.actions()).at(-1)).toBe("integration.writeback_pushed");
  });

  it("explicitly off behaves like unset, and the env switch is read as a strict true/false, default false", () => {
    const base = {
      DATABASE_URL: "postgresql://app_user:x@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      AUTH_SECRET: "a".repeat(40),
      S3_BUCKET: "b",
      S3_ACCESS_KEY_ID: "id",
      S3_SECRET_ACCESS_KEY: "s",
      FIELD_ENCRYPTION_KEY: `k1:${Buffer.alloc(32, 7).toString("base64")}`,
    };
    expect(parseEnv(base).WRITE_BACK_LIVE).toBe("false");
    expect(parseEnv({ ...base, WRITE_BACK_LIVE: "true" }).WRITE_BACK_LIVE).toBe("true");
    expect(() => parseEnv({ ...base, WRITE_BACK_LIVE: "yes" })).toThrow(/WRITE_BACK_LIVE/);
  });
});
