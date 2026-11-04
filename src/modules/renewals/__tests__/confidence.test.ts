import { describe, expect, it } from "vitest";
import { confidence, type ConfidenceInput } from "../confidence";
import { confidenceConfig, DEFAULT_CONFIDENCE, FACTOR_MODEL } from "../schemas";

/**
 * M7 §5 confidence.test: the deterministic renewal likelihood. Each factor's sign and bounds,
 * clamping, the band edges, missing data excluded (never lowering confidence, Rule 4), a source on
 * every factor, and a Northgate-like fixture with an exact figure and reason list. Pure: no
 * database, no clock, no model (D-75).
 */
const acct = { sourceType: "Account", sourceId: "acc" };
const none = (over: Partial<ConfidenceInput> = {}): ConfidenceInput => ({
  asOf: "2026-11-02",
  accountId: "acc",
  contractId: "con",
  renewalDate: "2026-12-13",
  noticeDeadline: null,
  health: null,
  signals: null,
  champion: null,
  invoices: null,
  plan: null,
  usage: null,
  ...over,
});
const run = (over: Partial<ConfidenceInput> = {}, cfg = FACTOR_MODEL) =>
  confidence(none(over), cfg);
const factor = (r: ReturnType<typeof run>, key: string) => r.factors.find((f) => f.key === key)!;

describe("every factor, one at a time", () => {
  it("health band: Healthy adds, Watch and At Risk take off; no score is no factor", () => {
    const h = (band: "HEALTHY" | "WATCH" | "AT_RISK" | "INSUFFICIENT_DATA") =>
      run({ health: { band, overall: 60, trend30: null, sources: [acct] } });
    expect(factor(h("HEALTHY"), "health_band").points).toBe(10);
    expect(factor(h("WATCH"), "health_band").points).toBe(-10);
    expect(factor(h("AT_RISK"), "health_band").points).toBe(-30);
    expect(factor(h("INSUFFICIENT_DATA"), "health_band").points).toBeNull();
    expect(h("AT_RISK").confidence).toBe(40);
  });

  it("health trend over 30 days: falling takes off, rising adds, small moves count for nothing", () => {
    const t = (trend30: number | null) =>
      factor(
        run({ health: { band: "WATCH", overall: 60, trend30, sources: [acct] } }),
        "health_trend",
      );
    expect(t(-10).points).toBe(-8);
    expect(t(-25).points).toBe(-8);
    expect(t(-5).points).toBe(-4);
    expect(t(-9.9).points).toBe(-4);
    expect(t(-4.9).points).toBe(0);
    expect(t(4.9).points).toBe(0);
    expect(t(5).points).toBe(4);
    expect(t(null).points).toBeNull();
  });

  it("open risk signals: critical −12, warn −6, capped at −30; none open is 0, unknown is null", () => {
    const s = (...sev: Array<"WARN" | "CRITICAL">) =>
      factor(
        run({
          signals: sev.map((severity, i) => ({
            key: `r${i}`,
            severity,
            title: `Signal ${i}`,
            sources: [{ sourceType: "Signal", sourceId: `s${i}` }],
          })),
        }),
        "signals",
      );
    expect(s("WARN").points).toBe(-6);
    expect(s("CRITICAL").points).toBe(-12);
    expect(s("CRITICAL", "WARN").points).toBe(-18);
    expect(s("CRITICAL", "CRITICAL", "CRITICAL", "WARN").points).toBe(-30);
    expect(s().points).toBe(0);
    expect(factor(run({ signals: null }), "signals").points).toBeNull();
  });

  it("champion: active adds, silent and gone take off; no champion on record is null, not bad news", () => {
    const c = (state: "ACTIVE" | "SILENT" | "GONE", days: number | null = 3) =>
      factor(
        run({
          champion: {
            state,
            name: "Maya",
            silentDays: days,
            sources: [{ sourceType: "Contact", sourceId: "c1" }],
          },
        }),
        "champion",
      );
    expect(c("ACTIVE").points).toBe(5);
    expect(c("SILENT", 34).points).toBe(-15);
    expect(c("SILENT", 34).reason).toContain("34 days");
    expect(c("GONE", null).points).toBe(-25);
    expect(factor(run({ champion: null }), "champion").points).toBeNull();
  });

  it("promises are always null until M9 provides them (Rule 4), never 0", () => {
    const f = factor(run(), "promises");
    expect(f.points).toBeNull();
    expect(f.reason).toMatch(/Late promises are not counted by the shipped model/);
  });

  it("invoices: failed unpaid −15, late unpaid −10, paid late −5, clean +5; the worst applies", () => {
    const inv = (over: Partial<NonNullable<ConfidenceInput["invoices"]>[number]> = {}) => ({
      id: "i1",
      number: "INV-1",
      issuedDate: "2026-09-01",
      dueDate: "2026-09-15",
      paidDate: "2026-09-16",
      failedDate: null,
      isVoid: false,
      ...over,
    });
    const f = (...i: ReturnType<typeof inv>[]) => factor(run({ invoices: i }), "invoices");
    expect(f(inv()).points).toBe(5);
    expect(f(inv({ paidDate: "2026-10-06" })).points).toBe(-5); // paid 21 days late
    expect(f(inv({ paidDate: null })).points).toBe(-10); // unpaid, 48 days past due
    expect(f(inv({ paidDate: null, failedDate: "2026-10-01" })).points).toBe(-15);
    expect(
      f(
        inv({ paidDate: "2026-10-06" }),
        inv({ id: "i2", paidDate: null, failedDate: "2026-10-30" }),
      ).points,
    ).toBe(-15);
    // An open invoice not yet late, and a void one, change nothing.
    expect(f(inv({ paidDate: null, dueDate: "2026-11-02" })).points).toBe(5);
    expect(f(inv({ isVoid: true, paidDate: null })).points).toBeNull();
    // An old late payment is outside the look-back window.
    expect(
      f(inv({ issuedDate: "2025-01-01", dueDate: "2025-01-15", paidDate: "2025-03-01" })).points,
    ).toBe(5);
    expect(factor(run({ invoices: null }), "invoices").points).toBeNull();
    expect(factor(run({ invoices: [] }), "invoices").points).toBeNull();
  });

  it("notice: a close deadline with no plan takes off, a plan adds; unknown without a notice period or a plan record", () => {
    const n = (noticeDeadline: string | null, plan: ConfidenceInput["plan"]) =>
      factor(run({ noticeDeadline, plan }), "notice");
    const noPlan = { exists: false, sources: [{ sourceType: "Renewal", sourceId: "r" }] };
    const plan = { exists: true, sources: [{ sourceType: "Renewal", sourceId: "r" }] };
    expect(n("2026-11-13", noPlan).points).toBe(-10); // 11 days
    expect(n("2026-11-16", noPlan).points).toBe(-10); // exactly 14 days
    expect(n("2026-11-17", noPlan).points).toBe(0); // 15 days
    expect(n("2026-10-30", noPlan).points).toBe(-10); // passed
    expect(n("2026-11-13", plan).points).toBe(5);
    expect(n(null, noPlan).points).toBeNull();
    expect(n("2026-11-13", null).points).toBeNull(); // plan history is not knowable (back-test)
  });

  it("usage against the account's own normal: bands at 90, 70 and 50 percent", () => {
    const u = (current: number, normal: number | null) =>
      factor(
        run({
          usage: { current, normal, sources: [{ sourceType: "UsageDaily", accountId: "acc" }] },
        }),
        "usage",
      );
    expect(u(9, 10).points).toBe(5);
    expect(u(8.9, 10).points).toBe(0);
    expect(u(7, 10).points).toBe(0);
    expect(u(6.9, 10).points).toBe(-10);
    expect(u(5, 10).points).toBe(-10);
    expect(u(4.9, 10).points).toBe(-20);
    expect(u(3, null).points).toBeNull();
    expect(u(3, 0).points).toBeNull();
  });
});

describe("the total", () => {
  it("is the base when nothing is known, and unknown factors never lower it (Rule 4)", () => {
    const r = run();
    expect(r.confidence).toBe(70);
    expect(r.band).toBe("HIGH");
    expect(r.factors.every((f) => f.points === null)).toBe(true);
    expect(r.missing.length).toBe(r.factors.length);
  });

  it("clamps at 0 and at 100", () => {
    const worst = run({
      health: { band: "AT_RISK", overall: 10, trend30: -20, sources: [acct] },
      signals: Array.from({ length: 5 }, (_, i) => ({
        key: `k${i}`,
        severity: "CRITICAL" as const,
        title: "t",
        sources: [acct],
      })),
      champion: { state: "GONE", name: "M", silentDays: null, sources: [acct] },
    });
    expect(worst.confidence).toBe(0);
    expect(worst.band).toBe("LOW");
    const best = confidence(
      none({ health: { band: "HEALTHY", overall: 95, trend30: 9, sources: [acct] } }),
      confidenceConfig.parse({ base: 95 }),
    );
    expect(best.confidence).toBe(100);
  });

  it("band edges: 39 is low, 40 medium, 69 medium, 70 high; the lines are settings", () => {
    const at = (base: number) => confidence(none(), confidenceConfig.parse({ base })).band;
    expect([at(39), at(40), at(69), at(70)]).toEqual(["LOW", "MEDIUM", "MEDIUM", "HIGH"]);
    const custom = confidenceConfig.parse({
      base: 75,
      bands: { highAtLeast: 80, mediumAtLeast: 50 },
    });
    expect(confidence(none(), custom).band).toBe("MEDIUM");
    expect(() =>
      confidenceConfig.parse({ bands: { highAtLeast: 40, mediumAtLeast: 40 } }),
    ).toThrow();
  });

  it("every factor, including the ones with no data, names at least one source", () => {
    for (const r of [run(), northgate()])
      for (const f of r.factors) expect(f.sources.length).toBeGreaterThan(0);
  });

  it("changing a weight changes the figure by exactly that weight", () => {
    const base = run({ health: { band: "WATCH", overall: 60, trend30: null, sources: [acct] } });
    const tweaked = confidence(
      none({ health: { band: "WATCH", overall: 60, trend30: null, sources: [acct] } }),
      confidenceConfig.parse({ healthBand: { WATCH: -20 } }),
    );
    expect(base.confidence - tweaked.confidence).toBe(10);
  });
});

function northgateInput() {
  return none({
    renewalDate: "2026-12-13",
    noticeDeadline: "2026-11-13",
    health: {
      band: "WATCH",
      overall: 58,
      trend30: -12,
      sources: [{ sourceType: "HealthScoreSnapshot", sourceId: "snap" }],
    },
    signals: [
      {
        key: "ticket_open_too_long",
        severity: "WARN",
        title: "Ticket open too long",
        sources: [{ sourceType: "Ticket", sourceId: "t1" }],
      },
    ],
    champion: {
      state: "SILENT",
      name: "Dana",
      silentDays: 34,
      sources: [{ sourceType: "Contact", sourceId: "c1" }],
    },
    invoices: [
      {
        id: "i1",
        number: "NG-1",
        issuedDate: "2026-08-20",
        dueDate: "2026-09-01",
        paidDate: "2026-09-22",
        failedDate: null,
        isVoid: false,
      },
    ],
    plan: { exists: false, sources: [{ sourceType: "Renewal", sourceId: "r1" }] },
    usage: {
      current: 6.2,
      normal: 10,
      sources: [{ sourceType: "UsageDaily", accountId: "acc" }],
    },
  });
}

function northgate() {
  return confidence(northgateInput(), FACTOR_MODEL);
}

describe("a Northgate-like fixture (hand-computed; the seed's own number is reported, never tuned: D2)", () => {
  it("is exactly 6 (low) with this exact reason list", () => {
    const r = northgate();
    // 70 base − 10 Watch − 8 falling 12 points − 6 one warn − 15 silent 34 days − 5 paid 21 days
    // late − 10 notice deadline in 11 days with no plan − 10 usage at 62% of normal; promises: none.
    expect(r.confidence).toBe(6);
    expect(r.band).toBe("LOW");
    expect(r.factors.map((f) => [f.key, f.points])).toEqual([
      ["health_band", -10],
      ["health_trend", -8],
      ["signals", -6],
      ["champion", -15],
      ["promises", null],
      ["invoices", -5],
      ["notice", -10],
      ["usage", -10],
    ]);
    expect(factor(r, "champion").reason).toBe("The champion, Dana, has been silent for 34 days");
    expect(factor(r, "notice").reason).toBe(
      "The notice deadline is in 11 days and there is no renewal plan",
    );
    expect(r.missing).toEqual([factor(r, "promises").reason]);
  });

  it("is the same every time (deterministic)", () => {
    expect(JSON.stringify(northgate())).toBe(JSON.stringify(northgate()));
  });
});

describe("the shipped defaults are the simple model (D-118)", () => {
  it("count the health band and the notice deadline only; every other factor is listed at 0 points", () => {
    const r = northgateWith(DEFAULT_CONFIDENCE);
    // 70 base − 10 Watch − 10 notice deadline in 11 days with no plan; the rest is reported, not counted.
    expect(r.confidence).toBe(50);
    expect(r.band).toBe("MEDIUM");
    expect(r.factors.map((f) => [f.key, f.points])).toEqual([
      ["health_band", -10],
      ["health_trend", 0],
      ["signals", 0],
      ["champion", 0],
      ["promises", null],
      ["invoices", 0],
      ["notice", -10],
      ["usage", 0],
    ]);
    expect(factor(r, "champion").reason).toContain("silent for 34 days");
  });
});

function northgateWith(cfg: typeof DEFAULT_CONFIDENCE) {
  const base = northgate;
  void base;
  return confidence(northgateInput(), cfg);
}
