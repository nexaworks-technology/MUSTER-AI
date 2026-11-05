import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { addDays } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { countQueries } from "@/test/query-counter";
import {
  listAccountOutcomes,
  loadLedger,
  loadSaveRecord,
  type LedgerActor,
} from "../ledger.service";
import { RESTRICTED } from "../ledger";

/**
 * M11 S3: the ledger on the database. Totals reconcile with a direct count over OutcomeRecords,
 * M7's `valueSavedMinor` agrees with the ledger's per-record saved value (D-162), a CSM sees only
 * their own book, another workspace never leaks in, money needs revenue access, and the loader's
 * query count does not grow with the number of accounts.
 */
const NOW = new Date("2026-11-05T12:00:00Z");
const clock = () => NOW;
const TODAY = "2026-11-05";

type Setup = { actor: LedgerActor; ws: string };
async function workspace(label: string): Promise<Setup> {
  const { actor } = await createTestAdmin(label);
  return { actor: { ...actor, workspace: { timezone: "UTC" } }, ws: actor.workspaceId };
}

async function flag(
  s: Setup,
  opts: {
    accountId?: string;
    owner?: string | null;
    d90?: { status: string; acted: boolean; dueDaysAgo: number } | null;
    arr?: bigint | null;
    flagType?: "RISK" | "OPPORTUNITY";
    saved?: boolean;
  } = {},
) {
  const db = scopedDb(s.actor);
  const accountId =
    opts.accountId ??
    (
      await db.account.create({
        data: {
          workspaceId: s.ws,
          name: `L ${randomUUID().slice(0, 6)}`,
          tier: "MID_TOUCH",
          ownerMembershipId: opts.owner ?? null,
        },
      })
    ).id;
  const dueOn = opts.d90 ? addDays(TODAY, -opts.d90.dueDaysAgo) : addDays(TODAY, -10);
  const flaggedAt = new Date(`${addDays(dueOn, -90)}T09:00:00Z`);
  const signal = await db.signal.create({
    data: {
      workspaceId: s.ws,
      accountId,
      ruleKey: "usage_drop_vs_normal",
      ruleVersion: 1,
      category: "USAGE",
      severity: "WARN",
      polarity: opts.flagType ?? "RISK",
      title: "t",
      explanation: "e",
      evidence: [{ sourceType: "Account", sourceId: accountId }],
      values: {},
      params: {},
      dedupeKey: `d:${randomUUID()}`,
      firstSeenAt: flaggedAt,
      lastSeenAt: flaggedAt,
    },
  });
  const arr = opts.arr === undefined ? 10_000_00n : opts.arr;
  const d90 = opts.d90
    ? {
        day: 90,
        status: opts.d90.status,
        dueOn,
        actionTaken: opts.d90.acted ? "ACTED" : "IGNORED",
        evidence: [],
        detail: "d",
        attributed: true,
        note: "n",
      }
    : null;
  const record = await db.outcomeRecord.create({
    data: {
      workspaceId: s.ws,
      accountId,
      signalId: signal.id,
      flagType: opts.flagType ?? "RISK",
      flaggedAt,
      arrAtFlagMinor: arr,
      arrCurrency: arr === null ? null : "USD",
      actionTaken: opts.d90?.acted ? "ACTED" : "PENDING",
      firstActionAt: opts.d90?.acted ? flaggedAt : null,
      d90Outcome: d90 ?? undefined,
      valueSavedMinor: opts.d90?.acted && opts.d90.status === "RENEWED" ? arr : null,
    },
  });
  return { accountId, record };
}

describe("loadLedger (database)", () => {
  let a: Setup;
  let b: Setup;
  let csmActor: LedgerActor;
  let ownAccountId: string;

  beforeAll(async () => {
    a = await workspace("LedgerA");
    b = await workspace("LedgerB");
    const csmUser = await rawDb.user.create({
      data: { email: `csm-${randomUUID().slice(0, 8)}@example.test`, name: "CSM" },
    });
    const csm = await rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${a.ws}, true)`;
      return tx.membership.create({
        data: { workspaceId: a.ws, userId: csmUser.id, role: "CSM", bookScope: "OWN" },
      });
    });
    csmActor = {
      workspaceId: a.ws,
      userId: csmUser.id,
      membershipId: csm.id,
      role: "CSM",
      canViewRevenue: false,
      bookScope: "OWN",
      workspace: { timezone: "UTC" },
    };
    const own = await flag(a, {
      owner: csm.id,
      d90: { status: "RENEWED", acted: true, dueDaysAgo: 20 },
    });
    ownAccountId = own.accountId;
    await flag(a, { d90: { status: "RECOVERED", acted: true, dueDaysAgo: 30 } });
    await flag(a, { d90: { status: "RENEWED", acted: false, dueDaysAgo: 40 } });
    await flag(a, { d90: { status: "CHURNED", acted: true, dueDaysAgo: 50 }, arr: null });
    await flag(a, { d90: { status: "RENEWED", acted: true, dueDaysAgo: 200 } }); // outside 90 days
    await flag(a, { d90: null });
    await flag(b, { d90: { status: "RENEWED", acted: true, dueDaysAgo: 10 } });
  });

  it("reconciles with a direct count over the outcome records", async () => {
    const { ledger } = await loadLedger(a.actor, { period: 90 }, clock);
    const direct = await scopedDb(a.actor).outcomeRecord.findMany({
      where: { flagType: "RISK", d90Outcome: { not: undefined } },
    });
    const inPeriod = direct.filter((r) => {
      const d = r.d90Outcome as { dueOn: string } | null;
      return d !== null && d.dueOn >= addDays(TODAY, -90) && d.dueOn <= TODAY;
    });
    const dd = (r: (typeof direct)[number]) =>
      r.d90Outcome as { status: string; actionTaken: string };
    expect(ledger.totals.flagged).toBe(inPeriod.length);
    expect(ledger.totals.flagged).toBe(4);
    expect(ledger.totals.acted).toBe(inPeriod.filter((r) => dd(r).actionTaken === "ACTED").length);
    expect(ledger.totals.savedCount).toBe(
      inPeriod.filter(
        (r) => dd(r).actionTaken === "ACTED" && ["RENEWED", "RECOVERED"].includes(dd(r).status),
      ).length,
    );
    expect(ledger.totals.savedMinor).toEqual([{ currency: "USD", minor: 2_000_000n }]);
    expect(ledger.totals.churned).toBe(1);
    expect(ledger.totals.awaiting).toBe(1);
    expect(ledger.records).toHaveLength(4);
  });

  it("agrees with M7's valueSavedMinor on every acted RENEWED record (D-162)", async () => {
    const { ledger } = await loadLedger(a.actor, { period: 365 }, clock);
    const rows = await scopedDb(a.actor).outcomeRecord.findMany({
      where: { valueSavedMinor: { not: null } },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const rec = ledger.records.find((x) => x.id === r.id);
      expect(rec?.saved).toBe(true);
      expect(rec?.savedMoney).toEqual({ minor: r.valueSavedMinor, currency: "USD" });
    }
  });

  it("shows a CSM with an OWN book only their accounts, and no money without revenue access", async () => {
    const { ledger } = await loadLedger(csmActor, { period: 90 }, clock);
    expect(ledger.totals.flagged).toBe(1);
    expect(ledger.records.map((r) => r.accountId)).toEqual([ownAccountId]);
    expect(ledger.totals.savedMinor).toBe(RESTRICTED);
    expect(ledger.totals.savedCount).toBe(1);
  });

  it("never includes another workspace's records", async () => {
    const { ledger } = await loadLedger(b.actor, { period: 90 }, clock);
    expect(ledger.totals.flagged).toBe(1);
    const ids = new Set(
      (await scopedDb(b.actor).outcomeRecord.findMany({ select: { id: true } })).map((r) => r.id),
    );
    expect(ledger.records.every((r) => ids.has(r.id))).toBe(true);
    const mine = await loadLedger(a.actor, { period: 365 }, clock);
    expect(mine.ledger.records.some((r) => ids.has(r.id))).toBe(false);
  });

  it("opens a save record for its own workspace only, with its evidence and definition inputs", async () => {
    const own = await scopedDb(a.actor).outcomeRecord.findFirstOrThrow({
      where: { accountId: ownAccountId },
    });
    const view = await loadSaveRecord(a.actor, own.id);
    expect(view?.saved).toBe(true);
    expect(view?.valueSavedMinor).toBe(own.valueSavedMinor);
    expect(view?.signal?.ruleKey).toBe("usage_drop_vs_normal");
    expect(await loadSaveRecord(b.actor, own.id)).toBeNull();
    const csmView = await loadSaveRecord(csmActor, own.id);
    expect(csmView?.valueSavedMinor).toBeNull();
  });

  it("uses the same number of queries for 2 and 5 accounts", async () => {
    const small = await workspace("LedgerQ2");
    const large = await workspace("LedgerQ5");
    for (let i = 0; i < 2; i++)
      await flag(small, { d90: { status: "RENEWED", acted: true, dueDaysAgo: 10 + i } });
    for (let i = 0; i < 5; i++)
      await flag(large, { d90: { status: "RENEWED", acted: true, dueDaysAgo: 10 + i } });
    await loadLedger(small.actor, {}, clock); // warm up
    const s = await countQueries(() => loadLedger(small.actor, {}, clock));
    const l = await countQueries(() => loadLedger(large.actor, {}, clock));
    expect(s.result.ledger.totals.flagged).toBe(2);
    expect(l.result.ledger.totals.flagged).toBe(5);
    expect(l.queries).toBe(s.queries);
  });

  it("the account tab and the save record use a fixed number of queries too", async () => {
    const few = await workspace("LedgerT2");
    const many = await workspace("LedgerT5");
    const first = await flag(few, { d90: { status: "RENEWED", acted: true, dueDaysAgo: 10 } });
    const firstMany = await flag(many, { d90: { status: "RENEWED", acted: true, dueDaysAgo: 10 } });
    await flag(few, {
      accountId: first.accountId,
      d90: { status: "NO_CHANGE", acted: false, dueDaysAgo: 12 },
    });
    for (let i = 0; i < 4; i++)
      await flag(many, {
        accountId: firstMany.accountId,
        d90: { status: "NO_CHANGE", acted: false, dueDaysAgo: 12 + i },
      });
    const task = await scopedDb(many.actor).task.create({
      data: { workspaceId: many.ws, accountId: firstMany.accountId, title: "Call", status: "DONE" },
    });
    await scopedDb(many.actor).outcomeRecord.update({
      where: { id: firstMany.record.id },
      data: {
        actionRefs: [
          { type: "Task", id: task.id },
          { type: "Task", id: "gone" },
        ],
      },
    });
    const a = await countQueries(() => listAccountOutcomes(few.actor, first.accountId));
    const b = await countQueries(() => listAccountOutcomes(many.actor, firstMany.accountId));
    expect(a.result).toHaveLength(2);
    expect(b.result).toHaveLength(5);
    expect(b.queries).toBe(a.queries);
    const s = await countQueries(() => loadSaveRecord(few.actor, first.record.id));
    const m = await countQueries(() => loadSaveRecord(many.actor, firstMany.record.id));
    expect(m.result?.actions).toHaveLength(2);
    expect(m.result?.actions.some((x) => x.href === null && x.note)).toBe(true);
    expect(m.queries).toBe(s.queries);
  });
});
