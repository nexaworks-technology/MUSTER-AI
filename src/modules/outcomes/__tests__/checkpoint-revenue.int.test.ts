import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { evaluateRevenueCheckpoints } from "../service";

/**
 * M7 B5: the revenue statuses RENEWED / EXPANDED / CONTRACTED / CHURNED on the outcome ledger's
 * write side (ARCHITECTURE §6.5, Q-15). Source: Session A's RenewalOutcome snapshots and the revenue
 * events. Deterministic, with evidence ids; value saved only when a RISK flag was ACTED and ended
 * RENEWED; value expanded is the positive expansion delta of an OPPORTUNITY flag; both labelled
 * attributed, never causal. Only records inside the 90-day window count; 30/90-day completion is
 * M11. Idempotent; scoped to the workspace.
 */
const DAY = 86_400_000;
const NOW = new Date("2026-11-02T12:00:00Z");
const clock = () => NOW;
const at = (daysAgo: number) => new Date(+NOW - daysAgo * DAY);
let db: ScopedDb;
let ws: string;
let membershipId: string;

beforeAll(async () => {
  const { actor } = await createTestAdmin("OutRev");
  db = scopedDb(actor);
  ws = actor.workspaceId;
  membershipId = actor.membershipId;
});

async function flagged(opts: {
  flag: "RISK" | "OPPORTUNITY";
  daysAgo: number;
  acted?: boolean;
  arr?: bigint | null;
}) {
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: `A ${randomUUID().slice(0, 6)}`,
      tier: "MID_TOUCH",
      timezone: "UTC",
    },
  });
  const signal = await db.signal.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      ruleKey: opts.flag === "RISK" ? "usage_drop_vs_normal" : "seats_near_limit",
      ruleVersion: 1,
      category: "USAGE",
      severity: "WARN",
      polarity: opts.flag,
      title: "t",
      explanation: "e",
      evidence: [{ sourceType: "Account", sourceId: account.id }],
      values: {},
      params: {},
      dedupeKey: `d:${account.id}`,
      firstSeenAt: at(opts.daysAgo),
      lastSeenAt: at(opts.daysAgo),
    },
  });
  const arr = opts.arr === undefined ? 14_200_000n : opts.arr;
  const outcome = await db.outcomeRecord.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      signalId: signal.id,
      flagType: opts.flag,
      flaggedAt: at(opts.daysAgo),
      arrAtFlagMinor: arr,
      arrCurrency: arr === null ? null : "USD",
      actionTaken: opts.acted ? "ACTED" : "PENDING",
    },
  });
  return { account, outcome };
}

async function renewal(accountId: string, result: "RENEWED" | "CHURNED", occurredDaysAgo: number) {
  const contract = await db.contract.create({
    data: {
      workspaceId: ws,
      accountId,
      startDate: at(400),
      renewalDate: at(occurredDaysAgo),
      valueMinor: 14_200_000n,
    },
  });
  const r = await db.renewal.create({
    data: {
      workspaceId: ws,
      accountId,
      contractId: contract.id,
      renewalDate: at(occurredDaysAgo),
      confidence: 70,
      confidenceBand: "HIGH",
      confidenceAsOf: at(occurredDaysAgo + 10),
      stage: result,
    },
  });
  return db.renewalOutcome.create({
    data: {
      workspaceId: ws,
      renewalId: r.id,
      accountId,
      result,
      occurredOn: at(occurredDaysAgo),
      outcomeArrMinor: result === "RENEWED" ? 14_200_000n : 0n,
      currency: "USD",
      detectedVia: "CONTRACT_RECORDS",
      forecastConfidence: 70,
      forecastBand: "HIGH",
      forecastAsOf: at(occurredDaysAgo + 10),
    },
  });
}

const event = (
  accountId: string,
  type: "EXPANSION" | "CONTRACTION" | "CHURN",
  delta: bigint,
  daysAgo: number,
) =>
  db.revenueEvent.create({
    data: {
      workspaceId: ws,
      accountId,
      type,
      deltaArrMinor: delta,
      currency: "USD",
      effectiveDate: at(daysAgo),
      sourceType: "Contract",
      sourceId: randomUUID(),
    },
  });

const read = async (id: string) => db.outcomeRecord.findUniqueOrThrow({ where: { id } });
const status = async (id: string) =>
  (await read(id)).revenueOutcome as Record<string, unknown> | null;

describe("revenue checkpoint statuses", () => {
  it("a RISK flag that was acted on and ended RENEWED: RENEWED with the outcome as evidence, value saved = ARR at flag, labelled attributed", async () => {
    const f = await flagged({ flag: "RISK", daysAgo: 60, acted: true });
    const o = await renewal(f.account.id, "RENEWED", 20);
    expect(await evaluateRevenueCheckpoints({ workspaceId: ws }, clock)).toMatchObject({
      evaluated: expect.any(Number),
    });
    const rec = await read(f.outcome.id);
    expect(rec.revenueOutcome).toMatchObject({
      status: "RENEWED",
      attributed: true,
      evidence: [{ sourceType: "RenewalOutcome", sourceId: o.id }],
    });
    expect(String((rec.revenueOutcome as { note: string }).note)).toMatch(
      /attributed.*not proven/i,
    );
    expect(rec.valueSavedMinor).toBe(14_200_000n);
    expect(rec.valueExpandedMinor).toBeNull();
  });

  it("an ignored RISK flag that renewed: RENEWED, but no value saved", async () => {
    const f = await flagged({ flag: "RISK", daysAgo: 60, acted: false });
    await renewal(f.account.id, "RENEWED", 20);
    await evaluateRevenueCheckpoints({ workspaceId: ws }, clock);
    const rec = await read(f.outcome.id);
    expect((rec.revenueOutcome as { status: string }).status).toBe("RENEWED");
    expect(rec.valueSavedMinor).toBeNull();
  });

  it("a RISK flag with no ARR at flag: RENEWED, value saved stays empty, never 0 (Rule 4)", async () => {
    const f = await flagged({ flag: "RISK", daysAgo: 60, acted: true, arr: null });
    await renewal(f.account.id, "RENEWED", 20);
    await evaluateRevenueCheckpoints({ workspaceId: ws }, clock);
    expect((await read(f.outcome.id)).valueSavedMinor).toBeNull();
  });

  it("CHURNED from the renewal outcome, whatever the action: no value saved", async () => {
    const f = await flagged({ flag: "RISK", daysAgo: 50, acted: true });
    const o = await renewal(f.account.id, "CHURNED", 10);
    await evaluateRevenueCheckpoints({ workspaceId: ws }, clock);
    const rec = await read(f.outcome.id);
    expect(rec.revenueOutcome).toMatchObject({
      status: "CHURNED",
      evidence: [{ sourceType: "RenewalOutcome", sourceId: o.id }],
    });
    expect(rec.valueSavedMinor).toBeNull();
  });

  it("CONTRACTED from a contraction event, and it outranks a renewal in the same window", async () => {
    const f = await flagged({ flag: "RISK", daysAgo: 50, acted: true });
    await renewal(f.account.id, "RENEWED", 15);
    const e = await event(f.account.id, "CONTRACTION", -2_000_000n, 14);
    await evaluateRevenueCheckpoints({ workspaceId: ws }, clock);
    const rec = await read(f.outcome.id);
    expect(rec.revenueOutcome).toMatchObject({
      status: "CONTRACTED",
      evidence: expect.arrayContaining([{ sourceType: "RevenueEvent", sourceId: e.id }]),
    });
    expect(rec.valueSavedMinor).toBeNull();
  });

  it("an OPPORTUNITY flag followed by expansion: EXPANDED, value expanded = the positive delta, attributed", async () => {
    const f = await flagged({ flag: "OPPORTUNITY", daysAgo: 40, acted: true });
    const e1 = await event(f.account.id, "EXPANSION", 1_080_000n, 12);
    const e2 = await event(f.account.id, "EXPANSION", 200_000n, 5);
    await evaluateRevenueCheckpoints({ workspaceId: ws }, clock);
    const rec = await read(f.outcome.id);
    expect(rec.revenueOutcome).toMatchObject({ status: "EXPANDED", attributed: true });
    expect((rec.revenueOutcome as { evidence: unknown[] }).evidence).toEqual(
      expect.arrayContaining([
        { sourceType: "RevenueEvent", sourceId: e1.id },
        { sourceType: "RevenueEvent", sourceId: e2.id },
      ]),
    );
    expect(rec.valueExpandedMinor).toBe(1_280_000n);
    expect(rec.valueSavedMinor).toBeNull();
  });

  it("records outside the window do not count: an expansion before the flag, or more than 90 days after", async () => {
    const before = await flagged({ flag: "OPPORTUNITY", daysAgo: 30 });
    await event(before.account.id, "EXPANSION", 500_000n, 45);
    const late = await flagged({ flag: "OPPORTUNITY", daysAgo: 200 });
    await event(late.account.id, "EXPANSION", 500_000n, 20);
    await evaluateRevenueCheckpoints({ workspaceId: ws }, clock);
    expect(await status(before.outcome.id)).toBeNull();
    expect(await status(late.outcome.id)).toBeNull();
  });

  it("nothing happened yet: no status and no value (silence is not a result)", async () => {
    const f = await flagged({ flag: "RISK", daysAgo: 30, acted: true });
    await evaluateRevenueCheckpoints({ workspaceId: ws }, clock);
    const rec = await read(f.outcome.id);
    expect(rec.revenueOutcome).toBeNull();
    expect(rec.valueSavedMinor).toBeNull();
  });

  it("is idempotent: a second run writes nothing and the same status stands", async () => {
    const f = await flagged({ flag: "RISK", daysAgo: 60, acted: true });
    await renewal(f.account.id, "RENEWED", 20);
    await evaluateRevenueCheckpoints({ workspaceId: ws }, clock);
    const first = await read(f.outcome.id);
    const again = await evaluateRevenueCheckpoints({ workspaceId: ws }, clock);
    const second = await read(f.outcome.id);
    expect(again).toMatchObject({ changed: 0 });
    expect(second.updatedAt).toEqual(first.updatedAt);
  });

  it("a later correction of the renewal outcome replaces the earlier one while the window is open", async () => {
    const f = await flagged({ flag: "RISK", daysAgo: 60, acted: true });
    const first = await renewal(f.account.id, "RENEWED", 20);
    await evaluateRevenueCheckpoints({ workspaceId: ws }, clock);
    expect((await status(f.outcome.id))!.status).toBe("RENEWED");
    await db.renewalOutcome.create({
      data: {
        workspaceId: ws,
        renewalId: first.renewalId,
        accountId: f.account.id,
        result: "CHURNED",
        occurredOn: at(19),
        outcomeArrMinor: 0n,
        currency: "USD",
        detectedVia: "HUMAN",
        recordedByMembershipId: membershipId,
        supersedesId: first.id,
        forecastConfidence: 70,
        forecastBand: "HIGH",
        forecastAsOf: at(30),
      },
    });
    await evaluateRevenueCheckpoints({ workspaceId: ws }, clock);
    const rec = await read(f.outcome.id);
    expect((rec.revenueOutcome as { status: string }).status).toBe("CHURNED");
    expect(rec.valueSavedMinor).toBeNull();
  });

  it("never reads another workspace's revenue records", async () => {
    const { actor: other } = await createTestAdmin("OutRevOther");
    const odb = scopedDb(other);
    const a = await flagged({ flag: "OPPORTUNITY", daysAgo: 40, acted: true });
    // An expansion on a different workspace's account never reaches this record.
    const otherAccount = await odb.account.create({
      data: { workspaceId: other.workspaceId, name: "Other", tier: "MID_TOUCH" },
    });
    await odb.revenueEvent.create({
      data: {
        workspaceId: other.workspaceId,
        accountId: otherAccount.id,
        type: "EXPANSION",
        deltaArrMinor: 9n,
        currency: "USD",
        effectiveDate: at(10),
        sourceType: "Contract",
        sourceId: randomUUID(),
      },
    });
    await evaluateRevenueCheckpoints({ workspaceId: ws }, clock);
    expect(await status(a.outcome.id)).toBeNull();
    expect(await odb.outcomeRecord.count({ where: { accountId: otherAccount.id } })).toBe(0);
  });
});
