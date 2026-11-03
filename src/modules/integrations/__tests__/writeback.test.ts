import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { approve } from "@/modules/approvals/service";
import type { IntegrationAdapter } from "../adapter";
import { ADAPTERS } from "../adapters";
import { sealCredentials } from "../credentials";
import { describeProviderError } from "../errors";
import { createFixtureTransport } from "../fixture-transport";
import {
  executeApprovedWriteBack,
  requestWriteBack,
  setWriteBack,
  WriteBackRefusedError,
} from "../writeback.service";

/**
 * M5 §5 writeback.test (Rule 7, founder D2): refused when off; refused for a field not listed;
 * a WRITE_BACK approval when allowed; the push happens only after approval, against the fake
 * transport, re-checking the gate; an AuditLog row on every path.
 */
function fake() {
  const transport = createFixtureTransport([
    {
      request: {
        method: "PATCH",
        path: "/crm/v3/objects/companies/hs-co-1",
        bodyIncludes: '"hubspot_owner_id":"hs-owner-9"',
      },
      response: { status: 200, headers: {}, body: { id: "hs-co-1" } },
    },
  ]);
  const push = vi.fn(
    async (ctx: { transport: typeof transport }, change: { externalId: string; value: string }) => {
      const res = await ctx.transport.request({
        method: "PATCH",
        url: `https://api.hubapi.test/crm/v3/objects/companies/${change.externalId}`,
        body: JSON.stringify({ properties: { hubspot_owner_id: change.value } }),
      });
      if (res.status !== 200) throw new Error("push failed");
    },
  );
  const adapter: IntegrationAdapter<Record<string, never>> = {
    provider: "HUBSPOT",
    category: "CRM",
    displayName: "Fake HubSpot",
    configSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
    auth: { kind: "apiKey", validate: async () => {} },
    testConnection: async () => ({ ok: true, message: "ok" }),
    async *sync() {},
    writeBack: {
      fields: [{ key: "ownerMembershipId", label: "Account owner" }],
      push: push as never,
    },
    describeError: (e) => describeProviderError(e, "HubSpot", "Reconnect HubSpot."),
  };
  return {
    push,
    transport,
    deps: { adapter: () => adapter as IntegrationAdapter<unknown>, transport: () => transport },
  };
}

async function setup(label: string) {
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
  const change = { field: "ownerMembershipId", accountId: account.id, value: actor.membershipId };
  const actions = async () =>
    (
      await db.auditLog.findMany({
        where: { targetId: integration.id },
        orderBy: { createdAt: "asc" },
      })
    ).map((a) => a.action);
  return { actor, db, integration, account, change, actions };
}

describe("write-back gate (Rule 7)", () => {
  it("is off by default and refuses, with an audit row and no approval", async () => {
    const S = await setup("WbOff");
    const f = fake();
    expect(S.integration.writeBackEnabled).toBe(false);
    await expect(requestWriteBack(S.actor, S.integration.id, S.change, f.deps)).rejects.toThrow(
      new WriteBackRefusedError("Write-back is off for HubSpot, so nothing was changed there."),
    );
    expect(await S.actions()).toEqual(["integration.writeback_refused"]);
    expect(await S.db.approval.count()).toBe(0);
    expect(f.push).not.toHaveBeenCalled();
  });

  it("refuses a field that is not in the allowed list", async () => {
    const S = await setup("WbField");
    const f = fake();
    await setWriteBack(
      S.actor,
      S.integration.id,
      { enabled: true, fields: ["ownerMembershipId"] },
      f.deps,
    );
    await expect(
      requestWriteBack(S.actor, S.integration.id, { ...S.change, field: "name" }, f.deps),
    ).rejects.toThrow(/not allowed for this field/);
    expect(await S.actions()).toEqual([
      "integration.writeback_changed",
      "integration.writeback_refused",
    ]);
  });

  it("when allowed, creates a WRITE_BACK approval; the push happens only once approved", async () => {
    const S = await setup("WbApprove");
    const f = fake();
    await setWriteBack(
      S.actor,
      S.integration.id,
      { enabled: true, fields: ["ownerMembershipId"] },
      f.deps,
    );
    const r = await requestWriteBack(S.actor, S.integration.id, S.change, f.deps);
    expect(r.status).toBe("PENDING_APPROVAL");
    const approval = await S.db.approval.findUniqueOrThrow({ where: { id: r.approvalId } });
    expect(approval).toMatchObject({
      kind: "WRITE_BACK",
      status: "PENDING",
      reason: "Update the account owner in HubSpot",
    });
    expect(f.push).not.toHaveBeenCalled();
    // Pending: the gate will not push.
    await expect(executeApprovedWriteBack(S.actor, r.approvalId, f.deps)).rejects.toThrow(
      /Only an approved/,
    );

    await S.db.approval.update({
      where: { id: r.approvalId },
      data: {
        status: "APPROVED",
        decidedById: S.actor.membershipId,
        decidedAt: new Date(),
        decidedVia: "APP",
      },
    });
    const pushed = await executeApprovedWriteBack(S.actor, r.approvalId, f.deps);
    expect(pushed.status).toBe("PUSHED");
    expect(f.push).toHaveBeenCalledOnce();
    expect(f.push.mock.calls[0]![1]).toMatchObject({ externalId: "hs-co-1", value: "hs-owner-9" });
    expect(f.transport.unmatched).toEqual([]);
    expect((await executeApprovedWriteBack(S.actor, r.approvalId, f.deps)).status).toBe(
      "ALREADY_PUSHED",
    );
    expect(f.push).toHaveBeenCalledOnce();
    expect(await S.actions()).toEqual([
      "integration.writeback_changed",
      "integration.writeback_requested",
      "integration.writeback_pushed",
    ]);
  });

  it("approving through the approvals service re-checks the gate: switched off since → refused, audited", async () => {
    const S = await setup("WbRecheck");
    const f = fake();
    await setWriteBack(
      S.actor,
      S.integration.id,
      { enabled: true, fields: ["ownerMembershipId"] },
      f.deps,
    );
    const r = await requestWriteBack(S.actor, S.integration.id, S.change, f.deps);
    await setWriteBack(S.actor, S.integration.id, { enabled: false }, f.deps);
    // approve() uses the adapter registry; the fake stands in for this one call.
    const saved = ADAPTERS.HUBSPOT;
    ADAPTERS.HUBSPOT = f.deps.adapter();
    const decided = await approve(S.actor, { approvalId: r.approvalId }).finally(() => {
      ADAPTERS.HUBSPOT = saved;
    });
    expect(decided.approval.status).toBe("APPROVED");
    expect(decided.writeBack).toEqual({
      status: "REFUSED",
      plain: "Write-back is off for HubSpot, so nothing was changed there.",
    });
    expect(f.push).not.toHaveBeenCalled();
    expect((await S.actions()).at(-1)).toBe("integration.writeback_refused");
  });

  it("refuses an account that is not linked to the provider, and an unmatched owner", async () => {
    const S = await setup("WbUnlinked");
    const f = fake();
    await setWriteBack(
      S.actor,
      S.integration.id,
      { enabled: true, fields: ["ownerMembershipId"] },
      f.deps,
    );
    const other = await S.db.account.create({
      data: {
        workspaceId: S.actor.workspaceId,
        name: "CSV only",
        tier: "LONG_TAIL",
        source: "CSV",
      },
    });
    await expect(
      requestWriteBack(S.actor, S.integration.id, { ...S.change, accountId: other.id }, f.deps),
    ).rejects.toThrow("This account is not linked to a HubSpot record.");
    await expect(
      requestWriteBack(
        S.actor,
        S.integration.id,
        { ...S.change, value: "cnotamatchedmember000000" },
        f.deps,
      ),
    ).rejects.toThrow("That member is not matched to a HubSpot owner.");
  });

  it("the switch is Admin-only, accepts only declared fields, and is audited with before/after", async () => {
    const S = await setup("WbSettings");
    const f = fake();
    await expect(
      setWriteBack(
        { ...S.actor, role: "CS_LEADER" },
        S.integration.id,
        { enabled: true, fields: ["ownerMembershipId"] },
        f.deps,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      setWriteBack(S.actor, S.integration.id, { enabled: true, fields: ["arrMinor"] }, f.deps),
    ).rejects.toThrow(/does not support writing that field/);
    await setWriteBack(
      S.actor,
      S.integration.id,
      { enabled: true, fields: ["ownerMembershipId"] },
      f.deps,
    );
    const log = await S.db.auditLog.findFirstOrThrow({
      where: { action: "integration.writeback_changed" },
    });
    expect(log.summary).toBe("Allowed write-back to HubSpot for: Account owner");
    expect(log.before).toEqual({ enabled: false, fields: [] });
    expect(log.after).toEqual({ enabled: true, fields: ["ownerMembershipId"] });
  });
});
