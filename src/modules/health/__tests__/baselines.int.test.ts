import { beforeAll, describe, expect, it } from "vitest";
import { addDays, utcMidnight } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { currentUsageSql, ownBaselinesSql } from "../baselines-sql";
import { ownBaseline } from "../engine/baselines";
import { currentUsage } from "../engine/windows";
import type { AccountBundle } from "../engine/types";

/**
 * The nightly SQL must compute exactly what the pure engine computes (M3.md slice 3: "SQL
 * implementation with an equivalence test"). Generated data covers gaps, weekends, short
 * history, a drop, and usage that stops.
 */
const ASOF = "2026-11-02";
type Row = { id: string; date: string; activeUsers: number; seatsUsed: null };

/** Deterministic pseudo-random numbers (no real randomness in tests). */
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
}

const SHAPES: Record<string, (d: number, r: () => number) => number | null> = {
  steady: (d, r) => Math.round(30 + r() * 8),
  weekends: (d, r) => (d % 7 < 2 ? 4 : Math.round(25 + r() * 5)),
  gappy: (d, r) => (r() < 0.3 ? null : Math.round(10 + r() * 10)),
  short: (d, r) => (d > 40 ? null : Math.round(12 + r() * 3)),
  dropped: (d, r) => Math.round((d < 30 ? 8 : 40) + r() * 3),
  stopped: (d, r) => (d < 12 ? null : 20 + Math.round(r() * 2)),
  empty: () => null,
};

let db: ReturnType<typeof scopedDb>;
let ws: string;
const usage = new Map<string, Row[]>();

beforeAll(async () => {
  const { actor } = await createTestAdmin("Baselines");
  ws = actor.workspaceId;
  db = scopedDb(actor);
  for (const [i, [name, shape]] of Object.entries(SHAPES).entries()) {
    const acct = await db.account.create({ data: { workspaceId: ws, name, tier: "MID_TOUCH" } });
    const r = rng(i + 1);
    const rows: Row[] = [];
    for (let d = 140; d >= 0; d--) {
      const v = shape(d, r);
      if (v !== null)
        rows.push({ id: `${name}${d}`, date: addDays(ASOF, -d), activeUsers: v, seatsUsed: null });
    }
    await db.usageDaily.createMany({
      data: rows.map((x) => ({
        workspaceId: ws,
        accountId: acct.id,
        date: utcMidnight(x.date),
        activeUsers: x.activeUsers,
        sessions: 0,
        events: 0,
      })),
    });
    usage.set(acct.id, rows);
  }
});

const stub = (accountId: string, asOf: string, rows: Row[]) =>
  ({ accountId, asOf, usage: rows.length ? rows : null }) as unknown as AccountBundle;

describe("baselines in SQL equal the pure engine", () => {
  for (const asOf of [ASOF, "2026-10-15", "2026-09-30"]) {
    it(`own normal as of ${asOf}`, async () => {
      const ids = [...usage.keys()];
      const sql = await ownBaselinesSql(db, ws, asOf, ids);
      for (const id of ids) {
        const pure = ownBaseline(usage.get(id)!, asOf);
        const got = sql.get(id)!;
        expect(got.historyDays, id).toBe(pure.historyDays);
        if (pure.median === null) expect(got.median, id).toBeNull();
        else expect(got.median, id).toBeCloseTo(pure.median, 9);
        if (pure.p25 === null) expect(got.p25, id).toBeNull();
        else expect(got.p25, id).toBeCloseTo(pure.p25, 9);
        expect([got.from, got.to]).toEqual([pure.from, pure.to]);
      }
    });

    it(`current usage as of ${asOf}`, async () => {
      const sql = await currentUsageSql(db, ws, asOf, 3);
      for (const [id, rows] of usage) {
        const pure = currentUsage(stub(id, asOf, rows), 3);
        const got = sql.get(id);
        if (!pure.ok) expect(got, id).toBeUndefined();
        else {
          expect(got?.value, id).toBeCloseTo(pure.value, 9);
          expect([got?.from, got?.to], id).toEqual([pure.from, pure.to]);
        }
      }
    });
  }

  it("never reads another workspace's usage", async () => {
    const other = await createTestAdmin("BaselinesOther");
    const otherDb = scopedDb(other.actor);
    const ids = [...usage.keys()];
    const sql = await ownBaselinesSql(otherDb, other.actor.workspaceId, ASOF, ids);
    for (const id of ids) expect(sql.get(id)).toMatchObject({ median: null, historyDays: 0 });
    expect((await currentUsageSql(otherDb, other.actor.workspaceId, ASOF, 3)).size).toBe(0);
  });
});
