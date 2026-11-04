import { beforeAll, describe, expect, it } from "vitest";
import { calendarDateOf } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { currentContract } from "@/modules/billing/service";
import { arrMismatches, waterfall, type WaterfallEvent } from "@/modules/revenue/service";
import { runSeed } from "../run";

/**
 * M7 A6 on the seed: the ARR waterfall reconciles to the minor unit, its closing ARR equals the
 * sum of the contracts in force (the D9 cross-check), and the seed has no revenue/contract
 * mismatches to report.
 */
let ws: string;
let base: string;
const db = () => scopedDb({ workspaceId: ws });
const AS_OF = "2026-11-02";

beforeAll(async () => {
  const [w] = await runSeed({ includeTestTenant: false });
  ws = w!.id;
  base = (await db().workspace.findFirstOrThrow()).baseCurrency;
}, 240_000);

async function events(): Promise<WaterfallEvent[]> {
  return (await db().revenueEvent.findMany()).map((e) => ({
    id: e.id,
    accountId: e.accountId,
    type: e.type,
    deltaArrMinor: e.deltaArrMinor,
    currency: e.currency,
    effectiveDate: calendarDateOf(e.effectiveDate),
  }));
}

describe("ARR waterfall on the seed", () => {
  it("reconciles for the quarter and for all time, and closing ARR equals the contracts in force", async () => {
    const ev = await events();
    const q = waterfall(ev, { from: "2026-08-01", to: AS_OF }, base);
    expect(q.base.reconciled).toBe(true);
    expect(q.base.anomalies).toEqual([]);
    const all = waterfall(ev, { from: "2000-01-01", to: AS_OF }, base);
    expect(all.base.openingMinor).toBe(0n);
    expect(all.base.closingMinor).toBe(q.base.closingMinor);

    const contracts = await db().contract.findMany();
    const byAccount = Map.groupBy(contracts, (c) => c.accountId);
    let inForce = 0n;
    for (const cs of byAccount.values()) {
      const c = currentContract(cs, new Date(`${AS_OF}T00:00:00Z`));
      if (c && c.currency === base && c.valueMinor !== null) inForce += c.valueMinor;
    }
    expect(q.base.closingMinor).toBe(inForce);
  });

  it("finds no revenue/contract mismatches in the seed", async () => {
    const contracts = (await db().contract.findMany()).map((c) => ({
      id: c.id,
      accountId: c.accountId,
      startDate: c.startDate,
      endDate: c.endDate,
      valueMinor: c.valueMinor,
      currency: c.currency,
      status: c.status,
    }));
    expect(arrMismatches(await events(), contracts, AS_OF)).toEqual([]);
  });
});
