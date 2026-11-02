import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { ownBaseline } from "@/modules/health/service";
import { RULES } from "../rules/catalog";
import { evaluateRule, type SignalBundle } from "../rules";

/**
 * Golden fixtures for every M3 rule (ARCHITECTURE §5.4, M3.md §5): each rule has at least one case
 * that fires and one that must not. Fixtures are JSON in fixtures/<ruleKey>/; long daily series use
 * ranges ({ fromDaysAgo, toDaysAgo, value }) that this test expands. Dates are relative to asOf.
 */
const DIR = path.join(import.meta.dirname, "fixtures");

type Range = { fromDaysAgo: number; toDaysAgo: number; value: number };
interface Fixture {
  name: string;
  asOf?: string;
  params?: Record<string, unknown>;
  open?: string[];
  bundle: Record<string, unknown> & {
    usage?: { series: Range[]; seatsUsed?: number | null } | null;
    userUsage?: Array<{
      externalUserId: string;
      contactId?: string | null;
      name?: string | null;
      series: Range[];
    }> | null;
    featureUsage?: Array<{ featureKey: string; series: Range[] }> | null;
  };
  expect: Array<{ dedupeKey: string; severity: "INFO" | "WARN" | "CRITICAL"; title?: string }>;
}

const expand = (asOf: string, series: Range[]) =>
  series.flatMap((r) =>
    Array.from({ length: r.fromDaysAgo - r.toDaysAgo + 1 }, (_, i) => ({
      date: addDays(asOf, -(r.fromDaysAgo - i)),
      value: r.value,
    })),
  );

function build(f: Fixture): SignalBundle {
  const asOf = f.asOf ?? "2026-11-02";
  const { usage, userUsage, featureUsage, ...rest } = f.bundle;
  const usageRows = usage
    ? expand(asOf, usage.series).map((d, i) => ({
        id: `u${i}`,
        date: d.date,
        activeUsers: d.value,
        seatsUsed: usage.seatsUsed ?? null,
      }))
    : null;
  return {
    accountId: "a1",
    asOf,
    tier: "MID_TOUCH",
    plan: "Growth",
    employeeBand: "51-200",
    useCase: null,
    usage: usageRows,
    ownBaseline: usageRows ? ownBaseline(usageRows, asOf) : null,
    cohort: null,
    userUsage: userUsage
      ? userUsage.flatMap((u) =>
          expand(asOf, u.series).map((d) => ({
            externalUserId: u.externalUserId,
            contactId: u.contactId ?? null,
            name: u.name ?? null,
            date: d.date,
            events: d.value,
          })),
        )
      : null,
    featureUsage: featureUsage
      ? featureUsage.flatMap((fu) =>
          expand(asOf, fu.series).map((d) => ({
            featureKey: fu.featureKey,
            date: d.date,
            users: d.value,
          })),
        )
      : null,
    keyFeatures: [],
    contract: null,
    messages: null,
    workspaceHasTickets: true,
    tickets: [],
    contacts: [],
    roles: [],
    invoices: [],
    revenueEvents: [],
    pulse: null,
    invoiceFailureCounts: {},
    meetings: null,
    ...rest,
  } as SignalBundle;
}

const fixtures = readdirSync(DIR).map((rule) => ({
  rule,
  cases: readdirSync(path.join(DIR, rule))
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({
      file,
      f: JSON.parse(readFileSync(path.join(DIR, rule, file), "utf8")) as Fixture,
    })),
}));

describe("every M3 rule has golden fixtures", () => {
  it.each(RULES.map((r) => r.key))("%s has a fire and a not-fire case", (key) => {
    const cases = fixtures.find((x) => x.rule === key)?.cases ?? [];
    // Outside events are entered by hand (INTERP-6): their "fire" path is the manual create,
    // tested in outside.int.test.ts. The evaluator must never invent one.
    if (key !== "outside_event")
      expect(
        cases.some((c) => c.f.expect.length > 0),
        `${key}: fire`,
      ).toBe(true);
    expect(
      cases.some((c) => c.f.expect.length === 0),
      `${key}: not fire`,
    ).toBe(true);
  });
});

for (const { rule, cases } of fixtures) {
  describe(rule, () => {
    it.each(cases.map((c) => [c.f.name, c] as const))("%s", (_name, { f }) => {
      const got = evaluateRule(rule as never, build(f), f.params ?? {}, {
        isOpen: (k) => (f.open ?? []).includes(k),
      });
      expect(got.map((g) => ({ dedupeKey: g.dedupeKey, severity: g.severity }))).toEqual(
        f.expect.map((e) => ({ dedupeKey: e.dedupeKey, severity: e.severity })),
      );
      for (const [i, e] of f.expect.entries()) if (e.title) expect(got[i]!.title).toBe(e.title);
      for (const g of got) {
        expect(g.evidence.length, "evidence").toBeGreaterThan(0);
        expect(g.explanation.length).toBeGreaterThan(0);
      }
    });
  });
}
