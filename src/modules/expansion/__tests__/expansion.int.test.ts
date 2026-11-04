import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import {
  ExpansionError,
  getAccountExpansion,
  listOpportunities,
  syncExpansion,
  updateOpportunity,
} from "../service";

/**
 * M7 B2: expansion.sync (one opportunity per account with a live expansion signal, an estimate only
 * from the account's own subscription), the read model (the estimate labelled with its method, no
 * money without revenue access), and the CRM export through the M5 write-back gate (D-116).
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

describe("expansion.sync", () => {
  it("Copperleaf's figure from its own records: 12 seats × $900 = $10,800, a labelled estimate; a re-run changes nothing", async () => {
    const w = await world("ExpA");
    const s = await w.seats();
    const first = await syncExpansion(w.actor, [w.account.id], ASOF);
    expect(first).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    const opp = await w.db.expansionOpportunity.findFirstOrThrow({
      where: { accountId: w.account.id },
    });
    expect(opp).toMatchObject({
      estimateMinor: 1_080_000n,
      currency: "USD",
      estimateMethod: "SEATS_OVER_LIMIT",
      isEstimate: true,
      status: "OPEN",
      ownerMembershipId: w.actor.membershipId,
      signalIds: [s.id],
    });
    expect(await syncExpansion(w.actor, [w.account.id], ASOF)).toMatchObject({
      created: 0,
      unchanged: 1,
    });
    const audit = await w.db.auditLog.findMany({
      where: { action: "expansion.opportunity_created" },
    });
    expect(audit).toHaveLength(1);
  });

  it("no price on file: the opportunity exists with no number, never 0", async () => {
    const w = await world("ExpNoPrice", { price: false });
    await w.seats();
    await syncExpansion(w.actor, [w.account.id], ASOF);
    const opp = await w.db.expansionOpportunity.findFirstOrThrow({
      where: { accountId: w.account.id },
    });
    expect(opp.estimateMinor).toBeNull();
    expect(opp.currency).toBeNull();
    expect(opp.estimateMethod).toBe("SEATS_OVER_LIMIT");
    const page = await listOpportunities(w.actor);
    expect(page.rows[0]!.estimateText).toMatch(/^No price on file/);
  });

  it("a new team or fast growth alone is an opportunity with no estimate (not over a limit)", async () => {
    const w = await world("ExpTeam");
    await w.signal("new_team_using", "13 new people started using the product", {
      newPeople: 13,
      team: null,
    });
    await syncExpansion(w.actor, [w.account.id], ASOF);
    const opp = await w.db.expansionOpportunity.findFirstOrThrow({
      where: { accountId: w.account.id },
    });
    expect(opp).toMatchObject({ estimateMinor: null, estimateMethod: null });
    expect((await listOpportunities(w.actor)).rows[0]!.estimateText).toMatch(/^No estimate/);
  });

  it("human fields survive a refresh; a dismissed opportunity is not brought back by the same episodes, a new episode is new", async () => {
    const w = await world("ExpHuman");
    const s1 = await w.seats();
    await syncExpansion(w.actor, [w.account.id], ASOF);
    const opp = await w.db.expansionOpportunity.findFirstOrThrow({
      where: { accountId: w.account.id },
    });
    await updateOpportunity(w.actor, opp.id, {
      nextStep: "Call Iris about seats",
      nextStepDate: "2026-11-09",
      status: "IN_PROGRESS",
    });
    const team = await w.signal("fast_growth", "Usage grew to 144% of normal", { ratio: 1.44 });
    expect(await syncExpansion(w.actor, [w.account.id], ASOF)).toMatchObject({ updated: 1 });
    const kept = await w.db.expansionOpportunity.findUniqueOrThrow({ where: { id: opp.id } });
    expect(kept).toMatchObject({ nextStep: "Call Iris about seats", status: "IN_PROGRESS" });
    expect(kept.signalIds.sort()).toEqual([s1.id, team.id].sort());
    await updateOpportunity(w.actor, opp.id, { status: "DISMISSED" });
    await syncExpansion(w.actor, [w.account.id], ASOF);
    expect(await w.db.expansionOpportunity.count({ where: { accountId: w.account.id } })).toBe(1);
    await w.signal("goal_stated_expansion", "Goal needs 60 seats; the contract has 40", {
      target: 60,
      seats: 40,
    });
    await syncExpansion(w.actor, [w.account.id], ASOF);
    expect(await w.db.expansionOpportunity.count({ where: { accountId: w.account.id } })).toBe(2);
  });

  it("only workspace A's signals make workspace A's opportunities", async () => {
    const a = await world("ExpIsoA");
    const b = await world("ExpIsoB");
    await a.seats();
    await syncExpansion(a.actor, [a.account.id, b.account.id], ASOF);
    expect(await b.db.expansionOpportunity.count()).toBe(0);
    expect(await a.db.expansionOpportunity.count()).toBe(1);
  });
});

describe("expansion read model", () => {
  it("shows the estimate with its method, the signals behind it and the whitespace panel", async () => {
    const w = await world("ExpRead");
    await w.seats();
    await syncExpansion(w.actor, [w.account.id], ASOF);
    const list = await listOpportunities(w.actor);
    const row = list.rows[0]!;
    expect(row.estimateText).toBe(
      "Estimate: $10,800.00 ARR (12 seats × $900.00 per seat, from their subscription)",
    );
    expect(row.isEstimate).toBe(true);
    expect(row.extraSeats).toBe(12);
    expect(row.signals.map((s) => s.title)).toEqual(["52 of 40 seats in use"]);
    expect(row.whitespace).toBeTruthy();
    const tab = await getAccountExpansion(w.actor, w.account.id);
    expect(tab.opportunities).toHaveLength(1);
    expect(tab.whitespace.seats).toMatchObject({ state: expect.any(String) });
  });

  it("without revenue access no money key, no figure and no price text anywhere (Rule 6N5)", async () => {
    const w = await world("ExpRedact");
    await w.seats();
    await syncExpansion(w.actor, [w.account.id], ASOF);
    const viewer = { ...w.actor, canViewRevenue: false };
    const list = await listOpportunities(viewer);
    const row = list.rows[0]!;
    expect(row.moneyVisible).toBe(false);
    for (const k of ["estimateMinor", "currency", "estimateText"]) expect(k in row).toBe(false);
    expect(row.extraSeats).toBe(12);
    const text = JSON.stringify(list, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(text).not.toMatch(/1080000|10,800|\$900|900\.00/);
    const tab = await getAccountExpansion(viewer, w.account.id);
    expect(JSON.stringify(tab, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(
      /1080000|10,800|\$900|900\.00/,
    );
    expect(tab.opportunities[0]!.canExport).toBe(false);
  });

  it("a CSM who is not the account's owner cannot edit its opportunity; one outside the book cannot even see it", async () => {
    const w = await world("ExpEdit");
    await w.seats();
    await syncExpansion(w.actor, [w.account.id], ASOF);
    const opp = await w.db.expansionOpportunity.findFirstOrThrow({});
    const other = { ...w.actor, role: "CSM" as const, membershipId: "cnotthisowner000000000000" };
    await expect(
      updateOpportunity({ ...other, bookScope: "ALL" }, opp.id, { status: "WON" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      updateOpportunity({ ...other, bookScope: "OWN" }, opp.id, { status: "WON" }),
    ).rejects.toBeInstanceOf(ExpansionError);
    expect(
      (await w.db.expansionOpportunity.findUniqueOrThrow({ where: { id: opp.id } })).status,
    ).toBe("OPEN");
  });
});
