import { describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { exportOpportunity, ExpansionError, syncExpansion } from "@/modules/expansion/service";
import { ADAPTERS } from "../adapters";
import { sealCredentials } from "../credentials";
import { createFixtureTransport } from "../fixture-transport";
import { createLiveTransport } from "../transport";
import { executeApprovedWriteBack, setWriteBack } from "../writeback.service";

/**
 * M7 B2: exporting an expansion opportunity to the CRM goes through the M5 write-back gate
 * (Rule 7) with D-116 in full: refused with no CRM, refused when write-back is off for the
 * integration or the field, an approval first, one new deal on the company carrying the labelled
 * estimate (or no amount), nothing sent over a live transport unless WRITE_BACK_LIVE is set.
 */
const ASOF = "2026-11-02";
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function world(label: string, opts: { price?: boolean } = {}) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: `${label} Studios`,
      tier: "MID_TOUCH",
      ownerMembershipId: actor.membershipId,
    },
  });
  const contract = await db.contract.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      startDate: d("2026-03-23"),
      endDate: d("2027-03-23"),
      renewalDate: d("2027-03-23"),
      valueMinor: 3_600_000n,
      seatsPurchased: 40,
    },
  });
  if (opts.price !== false)
    await db.subscription.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        contractId: contract.id,
        plan: "Growth",
        interval: "YEAR",
        amountMinor: 3_600_000n,
        quantity: 40,
      },
    });
  let n = 0;
  const signal = (
    ruleKey: string,
    title: string,
    values: Record<string, unknown>,
    status = "OPEN",
  ) =>
    db.signal.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        ruleKey,
        ruleVersion: 1,
        category: "USAGE",
        severity: "WARN",
        polarity: "OPPORTUNITY",
        status: status as "OPEN",
        title,
        explanation: title,
        evidence: [{ sourceType: "Contract", sourceId: contract.id }],
        values: values as object,
        params: {},
        dedupeKey: `${ruleKey}:${account.id}:${++n}`,
        firstSeenAt: d(ASOF),
        lastSeenAt: d(ASOF),
      },
    });
  const seats = () =>
    signal("seats_near_limit", "52 of 40 seats in use", { ratio: 1.3, used: 52, seats: 40 });
  return { actor, db, ws, account, contract, signal, seats };
}

describe("CRM export through the write-back gate (Rule 7, D-116)", () => {
  async function crm(w: Awaited<ReturnType<typeof world>>) {
    const integration = await w.db.integration.create({
      data: {
        workspaceId: w.ws,
        provider: "HUBSPOT",
        credentialsEnc: sealCredentials({ accessToken: "tok-test" }),
      },
    });
    await w.db.externalRef.create({
      data: {
        workspaceId: w.ws,
        integrationId: integration.id,
        source: "HUBSPOT",
        objectType: "Account",
        externalId: "hs-co-77",
        internalType: "Account",
        internalId: w.account.id,
      },
    });
    return integration;
  }
  const deal = () =>
    createFixtureTransport([
      {
        request: { method: "POST", path: "/crm/v3/objects/deals", bodyIncludes: "dealname" },
        response: { status: 201, headers: {}, body: { id: "d-9001", properties: {} } },
      },
    ]);
  const approved = async (w: Awaited<ReturnType<typeof world>>, approvalId: string) =>
    w.db.approval.update({
      where: { id: approvalId },
      data: {
        status: "APPROVED",
        decidedById: w.actor.membershipId,
        decidedAt: new Date(),
        decidedVia: "APP",
      },
    });

  it("no CRM connected: refused with the way forward, nothing created", async () => {
    const w = await world("ExpCrm0");
    await w.seats();
    await syncExpansion(w.actor, [w.account.id], ASOF);
    const opp = await w.db.expansionOpportunity.findFirstOrThrow({});
    await expect(exportOpportunity(w.actor, opp.id)).rejects.toThrow(/No CRM is connected/);
  });

  it("write-back off: refused, 'Turn on write-back for HubSpot to sync', audited, no approval", async () => {
    const w = await world("ExpCrm1");
    await w.seats();
    await syncExpansion(w.actor, [w.account.id], ASOF);
    const integration = await crm(w);
    const opp = await w.db.expansionOpportunity.findFirstOrThrow({});
    const err = await exportOpportunity(w.actor, opp.id).catch((e) => e);
    expect(err).toBeInstanceOf(ExpansionError);
    expect(err.message).toMatch(/^Turn on write-back for HubSpot to sync\./);
    expect(await w.db.approval.count()).toBe(0);
    expect(
      await w.db.auditLog.count({
        where: { action: "integration.writeback_refused", targetId: integration.id },
      }),
    ).toBe(1);
  });

  it("revenue access is required (the CRM record carries the estimate)", async () => {
    const w = await world("ExpCrm2");
    await w.seats();
    await syncExpansion(w.actor, [w.account.id], ASOF);
    const opp = await w.db.expansionOpportunity.findFirstOrThrow({});
    await expect(
      exportOpportunity({ ...w.actor, canViewRevenue: false }, opp.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("allowed and approved: an approval first, then one new deal on the company with the labelled estimate; it cannot be exported twice", async () => {
    const w = await world("ExpCrm3");
    await w.seats();
    await syncExpansion(w.actor, [w.account.id], ASOF);
    const integration = await crm(w);
    const t = deal();
    const deps = { transport: () => t as never };
    await setWriteBack(w.actor, integration.id, {
      enabled: true,
      fields: ["expansionOpportunity"],
    });
    const opp = await w.db.expansionOpportunity.findFirstOrThrow({});
    const r = await exportOpportunity(w.actor, opp.id);
    expect(r.status).toBe("PENDING_APPROVAL");
    expect(t.calls).toHaveLength(0);
    const approval = await w.db.approval.findUniqueOrThrow({ where: { id: r.approvalId } });
    expect(approval.kind).toBe("WRITE_BACK");
    await expect(executeApprovedWriteBack(w.actor, r.approvalId, deps)).rejects.toThrow(
      /Only an approved/,
    );
    await approved(w, r.approvalId);
    const out = await executeApprovedWriteBack(w.actor, r.approvalId, deps);
    expect(out.status).toBe("PUSHED");
    expect(t.calls).toHaveLength(1);
    const body = JSON.parse(t.calls[0]!.body!);
    expect(body.properties).toMatchObject({
      dealname: "Expansion (estimate): ExpCrm3 Studios",
      amount: "10800.00",
    });
    expect(body.properties.description).toContain(
      "Estimate, not a quote: 12 seats × $900.00 per seat from the customer's own subscription = $10,800.00 a year.",
    );
    expect(body.associations[0].to.id).toBe("hs-co-77");
    expect(t.unmatched).toEqual([]);
    expect(
      (await w.db.expansionOpportunity.findUniqueOrThrow({ where: { id: opp.id } })).crmExternalId,
    ).toBe("d-9001");
    await expect(exportOpportunity(w.actor, opp.id)).rejects.toThrow(/already in the CRM/);
  });

  it("no estimate: the deal carries no amount (never 0)", async () => {
    const w = await world("ExpCrm4", { price: false });
    await w.seats();
    await syncExpansion(w.actor, [w.account.id], ASOF);
    const integration = await crm(w);
    const t = deal();
    await setWriteBack(w.actor, integration.id, {
      enabled: true,
      fields: ["expansionOpportunity"],
    });
    const opp = await w.db.expansionOpportunity.findFirstOrThrow({});
    const r = await exportOpportunity(w.actor, opp.id);
    await approved(w, r.approvalId);
    await executeApprovedWriteBack(w.actor, r.approvalId, { transport: () => t as never });
    const body = JSON.parse(t.calls[0]!.body!);
    expect("amount" in body.properties).toBe(false);
    expect(body.properties.description).toContain("No estimate: no price on file");
  });

  it("over a live transport with WRITE_BACK_LIVE unset: refused, nothing sent, audited (D-116 in full)", async () => {
    expect(process.env.WRITE_BACK_LIVE).toBeUndefined();
    const w = await world("ExpCrm5");
    await w.seats();
    await syncExpansion(w.actor, [w.account.id], ASOF);
    const integration = await crm(w);
    await setWriteBack(w.actor, integration.id, {
      enabled: true,
      fields: ["expansionOpportunity"],
    });
    const opp = await w.db.expansionOpportunity.findFirstOrThrow({});
    const r = await exportOpportunity(w.actor, opp.id);
    await approved(w, r.approvalId);
    const fetchStub = vi.fn(async () => new Response("{}", { status: 201 }));
    const live = createLiveTransport(fetchStub as never);
    const out = await executeApprovedWriteBack(w.actor, r.approvalId, {
      transport: () => live as never,
    });
    expect(out.status).toBe("REFUSED");
    expect(out.plain).toMatch(/WRITE_BACK_LIVE is not set/);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(
      (await w.db.expansionOpportunity.findUniqueOrThrow({ where: { id: opp.id } })).crmExternalId,
    ).toBeNull();
  });

  it("the adapters declare the export apart from the owner field, which is unchanged", () => {
    for (const p of ["HUBSPOT", "SALESFORCE"] as const) {
      const wb = ADAPTERS[p]!.writeBack!;
      expect(wb.fields.map((f) => f.key)).toEqual(["ownerMembershipId"]);
      expect(wb.exports!.map((f) => f.key)).toEqual(["expansionOpportunity"]);
    }
  });
});
