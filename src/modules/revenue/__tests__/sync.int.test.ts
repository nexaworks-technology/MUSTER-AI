import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { syncArrChecks } from "../sync.service";

/**
 * M7 A6 (D9): revenue events against the contract in force. A disagreement opens one
 * ARR_MISMATCH item per account and currency, with no money in its text; it resolves when the
 * records agree again; a dismissed item stays dismissed; another workspace's records are never
 * read.
 */
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("syncArrChecks", () => {
  it("opens an item for a mismatch, is idempotent, resolves when fixed, respects dismissal", async () => {
    const { actor } = await createTestAdmin("ArrA");
    const db = scopedDb(actor);
    const ws = actor.workspaceId;
    const acct = await db.account.create({
      data: { workspaceId: ws, name: "ArrA Co", tier: "MID_TOUCH" },
    });
    const contract = await db.contract.create({
      data: {
        workspaceId: ws,
        accountId: acct.id,
        startDate: d("2026-01-01"),
        valueMinor: 12_000_00n,
      },
    });
    const event = await db.revenueEvent.create({
      data: {
        workspaceId: ws,
        accountId: acct.id,
        type: "NEW",
        deltaArrMinor: 10_000_00n,
        currency: "USD",
        effectiveDate: d("2026-01-01"),
        sourceType: "Contract",
        sourceId: contract.id,
      },
    });
    const first = await syncArrChecks(actor, [acct.id], "2026-11-02");
    expect(first).toEqual({ mismatches: 1, opened: 1, resolved: 0 });
    const issue = await db.dataQualityIssue.findFirstOrThrow({
      where: { kind: "ARR_MISMATCH", accountId: acct.id },
    });
    expect(issue.status).toBe("OPEN");
    expect(issue.detail).not.toMatch(/\$|12,?000|10,?000/); // no money figure in text visible without revenue access
    expect(issue.detail).toContain(contract.id);
    expect(await syncArrChecks(actor, [acct.id], "2026-11-02")).toEqual({
      mismatches: 1,
      opened: 0,
      resolved: 0,
    });
    expect(
      await db.dataQualityIssue.count({ where: { kind: "ARR_MISMATCH", accountId: acct.id } }),
    ).toBe(1);

    await db.revenueEvent.update({ where: { id: event.id }, data: { deltaArrMinor: 12_000_00n } });
    expect(await syncArrChecks(actor, [acct.id], "2026-11-02")).toEqual({
      mismatches: 0,
      opened: 0,
      resolved: 1,
    });
    expect((await db.dataQualityIssue.findUniqueOrThrow({ where: { id: issue.id } })).status).toBe(
      "RESOLVED",
    );

    await db.revenueEvent.update({ where: { id: event.id }, data: { deltaArrMinor: 1n } });
    expect((await syncArrChecks(actor, [acct.id], "2026-11-02")).opened).toBe(1); // reopens
    await db.dataQualityIssue.update({ where: { id: issue.id }, data: { status: "DISMISSED" } });
    expect(await syncArrChecks(actor, [acct.id], "2026-11-02")).toEqual({
      mismatches: 1,
      opened: 0,
      resolved: 0,
    });
    expect((await db.dataQualityIssue.findUniqueOrThrow({ where: { id: issue.id } })).status).toBe(
      "DISMISSED",
    );
  });

  it("never reads another workspace's records", async () => {
    const a = await createTestAdmin("ArrIsoA");
    const b = await createTestAdmin("ArrIsoB");
    const dbB = scopedDb(b.actor);
    const acctB = await dbB.account.create({
      data: { workspaceId: b.actor.workspaceId, name: "ArrIsoB Co", tier: "MID_TOUCH" },
    });
    await dbB.revenueEvent.create({
      data: {
        workspaceId: b.actor.workspaceId,
        accountId: acctB.id,
        type: "NEW",
        deltaArrMinor: 5_00n,
        currency: "USD",
        effectiveDate: d("2026-01-01"),
        sourceType: "Contract",
        sourceId: "x",
      },
    });
    expect(await syncArrChecks(a.actor, [acctB.id], "2026-11-02")).toEqual({
      mismatches: 0,
      opened: 0,
      resolved: 0,
    });
    expect(await dbB.dataQualityIssue.count({ where: { kind: "ARR_MISMATCH" } })).toBe(0);
  });
});
