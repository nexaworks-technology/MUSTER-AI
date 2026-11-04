import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { labelledOutcomes, modelConfigOf, scoreAsOf } from "@/modules/health/service";
import {
  chooseModel,
  DEFAULT_CONFIDENCE,
  runRenewalBacktest,
  SIMPLE_CONFIG,
} from "@/modules/renewals/service";
import { runSeed } from "../run";

/**
 * M7 rule 2 on the seeded history: the renewal-confidence back-test, as the engine actually
 * produces it (the numbers in the fixture are measured, never tuned to a target: D-59, D2). The
 * 12 churns and 12 renewals are scored as of 90, 60 and 30 days before each outcome from records
 * dated on or before that day. If the engine or seed changes, the fixture changes only with a
 * written reason in the milestone log.
 */
const FIXTURE = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dirname,
      "../../../src/modules/renewals/__tests__/fixtures/confidence-backtest-seed.json",
    ),
    "utf8",
  ),
) as Awaited<ReturnType<typeof runRenewalBacktest>>;

let ctx: { workspaceId: string };

beforeAll(async () => {
  const [ws] = await runSeed({ includeTestTenant: true });
  ctx = { workspaceId: ws!.id };
}, 180_000);

describe("renewal confidence back-test on the seed", () => {
  it("matches the recorded fixture exactly, and twice in a row", async () => {
    const a = await runRenewalBacktest(ctx, "2026-11-02");
    const b = await runRenewalBacktest(ctx, "2026-11-02");
    expect(JSON.parse(JSON.stringify(a))).toEqual(FIXTURE);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.outcomes).toEqual({ churns: 12, renewals: 12 });
    expect(a.rows.every((r) => r.scorable)).toBe(true);
  }, 240_000);

  it("scores every outcome at 90, 60 and 30 days and reports calibration by band and score", () => {
    expect(Object.keys(FIXTURE.horizons).sort()).toEqual(["30", "60", "90"]);
    for (const h of Object.values(FIXTURE.horizons))
      for (const m of [h.factor, h.simple]) {
        expect(m.n).toBe(24);
        expect(m.byBand.map((b) => b.label)).toEqual(["HIGH", "MEDIUM", "LOW"]);
        expect(m.byBand.reduce((n, b) => n + b.n, 0)).toBe(24);
        expect(m.byScore.reduce((n, b) => n + b.n, 0)).toBe(24);
      }
    expect(FIXTURE.pooled.factor.n).toBe(72);
  });

  it("ships the model the pre-registered rule picks, and the defaults are that model (D-118)", () => {
    expect(FIXTURE.shipped).toBe(
      chooseModel(FIXTURE.pooled.factor.brier, FIXTURE.pooled.simple.brier),
    );
    expect(FIXTURE.shipped).toBe("simple");
    expect(DEFAULT_CONFIDENCE).toEqual(SIMPLE_CONFIG);
    // The measured pooled figures behind it.
    expect(FIXTURE.pooled.simple.brier).toBeLessThan(FIXTURE.pooled.factor.brier!);
  });

  it("never looks ahead: at every as-of date the bundle holds nothing dated later, and no churn yet", async () => {
    const { outcomes } = await labelledOutcomes(ctx, "2026-11-02");
    const db = scopedDb(ctx);
    const model = await db.healthModel.findFirstOrThrow({
      where: { proposedBy: "SYSTEM_DEFAULT" },
    });
    const hm = { id: model.id, config: modelConfigOf(model) };
    for (const o of outcomes.slice(0, 8)) {
      const asOf = addDays(o.date, -30);
      const b = (await scoreAsOf(ctx, [o.accountId], asOf, hm)).get(o.accountId)!.bundle;
      const dates = [
        ...(b.messages ?? []).map((m) => m.date),
        ...b.invoices.flatMap((i) => [i.issuedDate, ...(i.paidDate ? [i.paidDate] : [])]),
        ...(b.usage ?? []).map((u) => u.date),
        ...b.revenueEvents.map((e) => e.effectiveDate),
        ...b.tickets.map((t) => t.openedDate),
      ];
      expect(dates.filter((d) => d > asOf)).toEqual([]);
      if (o.type === "CHURN")
        expect(b.revenueEvents.some((e) => e.type === "CHURN" && e.effectiveDate >= o.date)).toBe(
          false,
        );
    }
  }, 240_000);
});
