import { describe, expect, it } from "vitest";
import {
  LEDGER_DEFINITIONS,
  RESTRICTED,
  buildLedger,
  headlineSentence,
  type LedgerD90,
  type LedgerRow,
} from "../ledger";

/**
 * M11 S3: the "Did it work?" ledger arithmetic (spec §6L3, Q-15, D-162). Pure: plain rows in,
 * counts and money out. Cohort = RISK flags whose frozen d90 checkpoint is due inside the period;
 * flags still waiting for day 90 are `awaiting`, never guessed.
 */
const PERIOD = { from: "2026-08-07", to: "2026-11-05" };
let n = 0;

function d90(
  status: LedgerD90["status"],
  actionTaken: LedgerD90["actionTaken"],
  dueOn = "2026-10-01",
): LedgerD90 {
  return {
    status,
    actionTaken,
    dueOn,
    evidence: [{ sourceType: "RenewalOutcome", sourceId: `ev-${n}` }],
  };
}

function row(over: Partial<LedgerRow> = {}): LedgerRow {
  n += 1;
  return {
    id: `rec-${n}`,
    accountId: "acc-a",
    flagType: "RISK",
    flaggedAt: new Date("2026-07-01T00:00:00Z"),
    arrAtFlagMinor: 10_000n,
    arrCurrency: "USD",
    signalId: `sig-${n}`,
    ruleKey: "usage_drop_vs_normal",
    agentKey: null,
    playKey: null,
    d90: d90("NO_CHANGE", "IGNORED"),
    expansionDeltas: [],
    ...over,
  };
}

const opts = { ...PERIOD, canViewRevenue: true };

describe("buildLedger", () => {
  it("counts a save only when ACTED and RENEWED or RECOVERED", () => {
    const l = buildLedger(
      [
        row({ d90: d90("RENEWED", "ACTED") }),
        row({ d90: d90("RECOVERED", "ACTED") }),
        row({ d90: d90("RENEWED", "IGNORED") }),
        row({ d90: d90("RECOVERED", "IGNORED") }),
        row({ d90: d90("REPLIED", "ACTED") }),
      ],
      opts,
    );
    expect(l.totals.flagged).toBe(5);
    expect(l.totals.acted).toBe(3);
    expect(l.totals.ignored).toBe(2);
    expect(l.totals.recoveredOrRenewed).toBe(4);
    expect(l.totals.savedCount).toBe(2);
    expect(l.totals.savedMinor).toEqual([{ currency: "USD", minor: 20_000n }]);
  });

  it("never counts an IGNORED flag as saved, whatever happened", () => {
    const l = buildLedger([row({ d90: d90("RENEWED", "IGNORED") })], opts);
    expect(l.totals.savedCount).toBe(0);
    expect(l.totals.savedMinor).toEqual([]);
  });

  it("a null ARR is counted as saved but adds no money, and is never zero", () => {
    const l = buildLedger(
      [
        row({ d90: d90("RENEWED", "ACTED"), arrAtFlagMinor: null, arrCurrency: null }),
        row({ d90: d90("RENEWED", "ACTED") }),
      ],
      opts,
    );
    expect(l.totals.savedCount).toBe(2);
    expect(l.totals.savedWithoutArr).toBe(1);
    expect(l.totals.savedMinor).toEqual([{ currency: "USD", minor: 10_000n }]);
    const noArr = l.records.find((r) => r.arrAtFlagMinor === null)!;
    expect(noArr.savedMoney).toBeNull();
  });

  it("sums money per currency and never mixes them", () => {
    const l = buildLedger(
      [
        row({ d90: d90("RENEWED", "ACTED") }),
        row({ d90: d90("RENEWED", "ACTED"), arrCurrency: "EUR", arrAtFlagMinor: 500n }),
      ],
      opts,
    );
    expect(l.totals.savedMinor).toEqual(
      expect.arrayContaining([
        { currency: "USD", minor: 10_000n },
        { currency: "EUR", minor: 500n },
      ]),
    );
    expect(l.totals.savedMinor).toHaveLength(2);
  });

  it("keeps awaiting flags out of the cohort and counts them separately", () => {
    const l = buildLedger(
      [row({ d90: null }), row({ d90: null }), row({ d90: d90("CHURNED", "ACTED") })],
      opts,
    );
    expect(l.totals.flagged).toBe(1);
    expect(l.totals.awaiting).toBe(2);
    expect(l.totals.churned).toBe(1);
  });

  it("excludes checkpoints due outside the period and opportunity flags from the risk cohort", () => {
    const l = buildLedger(
      [
        row({ d90: d90("RENEWED", "ACTED", "2026-08-06") }),
        row({ d90: d90("RENEWED", "ACTED", "2026-11-06") }),
        row({ d90: d90("RENEWED", "ACTED", "2026-08-07") }),
        row({ flagType: "OPPORTUNITY", d90: d90("EXPANDED", "ACTED") }),
      ],
      opts,
    );
    expect(l.totals.flagged).toBe(1);
    expect(l.totals.opportunityFlagged).toBe(1);
  });

  it("counts churned and contracted separately", () => {
    const l = buildLedger(
      [row({ d90: d90("CHURNED", "IGNORED") }), row({ d90: d90("CONTRACTED", "ACTED") })],
      opts,
    );
    expect(l.totals.churned).toBe(1);
    expect(l.totals.contracted).toBe(1);
    expect(l.totals.savedCount).toBe(0);
  });

  it("sums positive expansion deltas for ACTED and EXPANDED opportunity flags only", () => {
    const l = buildLedger(
      [
        row({
          flagType: "OPPORTUNITY",
          d90: d90("EXPANDED", "ACTED"),
          expansionDeltas: [
            { currency: "USD", minor: 3_000n },
            { currency: "USD", minor: -50n },
            { currency: "USD", minor: 2_000n },
          ],
        }),
        row({
          flagType: "OPPORTUNITY",
          d90: d90("EXPANDED", "IGNORED"),
          expansionDeltas: [{ currency: "USD", minor: 9_000n }],
        }),
        row({ flagType: "OPPORTUNITY", d90: d90("NO_CHANGE", "ACTED") }),
      ],
      opts,
    );
    expect(l.totals.expandedCount).toBe(1);
    expect(l.totals.expandedMinor).toEqual([{ currency: "USD", minor: 5_000n }]);
  });

  it("redacts every money field without revenue access but keeps the counts", () => {
    const l = buildLedger(
      [
        row({ d90: d90("RENEWED", "ACTED") }),
        row({
          flagType: "OPPORTUNITY",
          d90: d90("EXPANDED", "ACTED"),
          expansionDeltas: [{ currency: "USD", minor: 100n }],
        }),
      ],
      { ...PERIOD, canViewRevenue: false },
    );
    expect(l.moneyVisible).toBe(false);
    expect(l.totals.savedCount).toBe(1);
    expect(l.totals.savedMinor).toBe(RESTRICTED);
    expect(l.totals.expandedMinor).toBe(RESTRICTED);
    expect(l.records.every((r) => r.arrAtFlagMinor === RESTRICTED)).toBe(true);
    expect(l.records.every((r) => r.savedMoney === RESTRICTED || r.savedMoney === null)).toBe(true);
    for (const g of [...l.byAccount, ...l.byPlay, ...l.byAgent, ...l.byRule])
      expect(g.counts.savedMinor).toBe(RESTRICTED);
    expect(JSON.stringify(l, (_k, v) => (typeof v === "bigint" ? `big:${v}` : v))).not.toContain(
      "big:",
    );
  });

  it("per-group counts sum to the totals for every grouping", () => {
    const l = buildLedger(
      [
        row({ accountId: "a", ruleKey: "r1", playKey: "p1", d90: d90("RENEWED", "ACTED") }),
        row({ accountId: "a", ruleKey: "r2", agentKey: "watcher", d90: d90("CHURNED", "IGNORED") }),
        row({ accountId: "b", ruleKey: "r1", playKey: "p1", d90: d90("RECOVERED", "ACTED") }),
        row({ accountId: "c", ruleKey: null, d90: d90("NO_CHANGE", "IGNORED") }),
        row({ accountId: "c", ruleKey: "r2", d90: null }),
      ],
      opts,
    );
    for (const groups of [l.byAccount, l.byPlay, l.byAgent, l.byRule]) {
      const sum = (k: "flagged" | "acted" | "ignored" | "savedCount" | "churned" | "awaiting") =>
        groups.reduce((s, g) => s + g.counts[k], 0);
      for (const k of ["flagged", "acted", "ignored", "savedCount", "churned", "awaiting"] as const)
        expect(sum(k)).toBe(l.totals[k]);
    }
    const usd = l.byAccount.flatMap((g) =>
      g.counts.savedMinor === RESTRICTED ? [] : g.counts.savedMinor.map((m) => m.minor),
    );
    expect(usd.reduce((a, b) => a + b, 0n)).toBe(20_000n);
  });

  it("groups rule-flagged records under their signal rule and agent-flagged under the agent", () => {
    const l = buildLedger(
      [row({ agentKey: "watcher-basic" }), row({ agentKey: null, ruleKey: "payment_failed" })],
      opts,
    );
    expect(l.byAgent.map((g) => g.key).sort()).toEqual([
      "agent:watcher-basic",
      "rule:payment_failed",
    ]);
    expect(l.byRule.map((g) => g.key).sort()).toEqual(["payment_failed", "usage_drop_vs_normal"]);
  });
});

describe("headlineSentence and definitions", () => {
  it("states counts that equal the ledger and carries the attribution label", () => {
    const l = buildLedger(
      [
        row({ d90: d90("RENEWED", "ACTED") }),
        row({ d90: d90("RECOVERED", "ACTED") }),
        row({ d90: d90("CHURNED", "IGNORED") }),
      ],
      opts,
    );
    const h = headlineSentence(l, 90);
    expect(h.text).toContain("Of 3 risks that reached their 90-day checkpoint in the last 90 days");
    expect(h.text).toContain("the team acted on 2");
    expect(h.text).toContain("2 recovered or renewed");
    expect(h.text).toContain("$200.00");
    expect(h.label).toBe("attributed, not proven causal");
    expect(h.definition).toBe(LEDGER_DEFINITIONS.saved);
  });

  it("says Restricted instead of money, and nothing about money when none was saved", () => {
    const rows = [row({ d90: d90("RENEWED", "ACTED") })];
    expect(
      headlineSentence(buildLedger(rows, { ...PERIOD, canViewRevenue: false }), 90).text,
    ).toContain("Restricted");
    const none = headlineSentence(buildLedger([row()], opts), 90);
    expect(none.text).not.toContain("worth");
  });

  it("has an empty state when nothing reached day 90", () => {
    const h = headlineSentence(buildLedger([row({ d90: null })], opts), 90);
    expect(h.empty).toBe(true);
    expect(h.text).toBe("No flags have reached their 90-day checkpoint yet");
  });

  it("defines saved and the M7 renewal figure in plain words", () => {
    expect(LEDGER_DEFINITIONS.saved).toBe(
      "ARR at the flag, for risks the team acted on that recovered or renewed by day 90. Attributed, not proven causal (Q-15).",
    );
    expect(LEDGER_DEFINITIONS.renewalSaved).toBe(
      "Renewal saved: ARR at the flag, for risks the team acted on that renewed within 90 days (renewals only).",
    );
  });
});
