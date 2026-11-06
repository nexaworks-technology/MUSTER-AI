import { describe, expect, it } from "vitest";
import {
  computePilotMetrics,
  isoWeekOf,
  percentile,
  weeksEndingAt,
  type PilotEvent,
} from "../pilot-metrics";

const M1 = { id: "m1", name: "Ana" };
const M2 = { id: "m2", name: "Bo" };
let n = 0;
const ev = (
  membershipId: string,
  name: string,
  at: string,
  subjectId: string | null = null,
): PilotEvent => ({
  id: `e${++n}`,
  membershipId,
  name,
  subjectId,
  occurredAt: new Date(at),
});

const AS_OF = "2026-11-06"; // a Friday in ISO week 2026-W45
const run = (events: PilotEvent[], weeks = 4) =>
  computePilotMetrics({ events, members: [M1, M2], weeks, asOf: AS_OF, timezone: "UTC" });
const fig = (r: ReturnType<typeof run>, m: string, key: string, week?: string) => {
  const row = r.members.find((x) => x.membershipId === m)!;
  return (week ? row.weekly[week]! : row.period)[key as "todayOpens"];
};

describe("isoWeekOf / weeksEndingAt", () => {
  it("labels ISO weeks, including year boundaries", () => {
    expect(isoWeekOf("2026-11-06")).toEqual({ label: "2026-W45", start: "2026-11-02" });
    expect(isoWeekOf("2027-01-01").label).toBe("2026-W53");
    expect(isoWeekOf("2024-12-30").label).toBe("2025-W01");
  });
  it("lists the last N weeks oldest first, ending with the week of asOf", () => {
    expect(weeksEndingAt(AS_OF, 3).map((w) => w.label)).toEqual([
      "2026-W43",
      "2026-W44",
      "2026-W45",
    ]);
  });
});

describe("percentile", () => {
  it("nearest-rank; null with no values", () => {
    expect(percentile([], 0.9)).toBeNull();
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });
});

describe("computePilotMetrics", () => {
  it("counts Today and Approvals opens per member per ISO week, with source ids", () => {
    const a = ev("m1", "today.opened", "2026-11-03T09:00:00Z");
    const b = ev("m1", "today.opened", "2026-11-04T09:00:00Z");
    const c = ev("m1", "today.opened", "2026-10-28T09:00:00Z");
    const d = ev("m1", "approvals.opened", "2026-11-03T10:00:00Z");
    const e = ev("m2", "today.opened", "2026-11-03T09:00:00Z");
    const r = run([a, b, c, d, e]);
    expect(fig(r, "m1", "todayOpens", "2026-W45")).toMatchObject({
      value: 2,
      sources: { type: "ProductEvent", ids: [a.id, b.id] },
    });
    expect(fig(r, "m1", "todayOpens", "2026-W44").value).toBe(1);
    expect(fig(r, "m1", "todayOpens").value).toBe(3);
    expect(fig(r, "m1", "approvalsOpens").sources.ids).toEqual([d.id]);
    expect(fig(r, "m2", "todayOpens").value).toBe(1);
  });

  it("a week with no opens is a real zero (the member was looked at); no member data is not invented", () => {
    const r = run([]);
    expect(fig(r, "m1", "todayOpens", "2026-W45").value).toBe(0);
  });

  it("ignores events outside the period and from members not listed", () => {
    const old = ev("m1", "today.opened", "2026-08-01T09:00:00Z");
    const stranger = ev("zz", "today.opened", "2026-11-03T09:00:00Z");
    const r = run([old, stranger]);
    expect(fig(r, "m1", "todayOpens").value).toBe(0);
    expect(r.members).toHaveLength(2);
  });

  it("flag acceptance = accepted / (accepted + false alarms); null, never 0, with no data", () => {
    expect(fig(run([]), "m1", "flagAcceptance").value).toBeNull();
    expect(fig(run([]), "m1", "flagAcceptance").reason).toMatch(/no flags/i);
    const ok1 = ev("m1", "signal.flag_accepted", "2026-11-03T09:00:00Z", "s1");
    const ok2 = ev("m1", "signal.flag_accepted", "2026-11-03T09:01:00Z", "s2");
    const ok3 = ev("m1", "signal.flag_accepted", "2026-11-03T09:02:00Z", "s3");
    const bad = ev("m1", "signal.false_alarm", "2026-11-04T09:00:00Z", "s4");
    const r = run([ok1, ok2, ok3, bad]);
    expect(fig(r, "m1", "flagAcceptance")).toMatchObject({ value: 75, unit: "percent" });
    expect(fig(r, "m1", "flagAcceptance").sources.ids).toEqual([ok1.id, ok2.id, ok3.id, bad.id]);
    const zero = run([ev("m1", "signal.false_alarm", "2026-11-04T09:00:00Z", "s9")]);
    expect(fig(zero, "m1", "flagAcceptance").value).toBe(0); // 0 of 1 decided is a real 0%
  });

  it("counts one verdict per signal: a false alarm overrides an earlier accept; repeats count once", () => {
    const a1 = ev("m1", "signal.flag_accepted", "2026-11-03T09:00:00Z", "s1");
    const a2 = ev("m1", "signal.flag_accepted", "2026-11-03T10:00:00Z", "s1");
    const a3 = ev("m1", "signal.flag_accepted", "2026-11-03T09:00:00Z", "s2");
    const f3 = ev("m1", "signal.false_alarm", "2026-11-04T09:00:00Z", "s2");
    const r = run([a1, a2, a3, f3]);
    const f = fig(r, "m1", "flagAcceptance");
    expect(f.value).toBe(50);
    expect(f.sources.ids).toEqual([a1.id, f3.id]);
  });

  it("prep time is generated -> shared per document: median and p90, null without pairs", () => {
    expect(fig(run([]), "m1", "qbrPrepMedian").value).toBeNull();
    const events: PilotEvent[] = [];
    // three QBRs prepped in 10, 20 and 90 minutes; a fourth never shared
    [10, 20, 90].forEach((mins, i) => {
      const g = new Date(Date.UTC(2026, 10, 3, 9, 0) + i * 3_600_000 * 3);
      events.push(ev("m1", "qbr.generated", g.toISOString(), `d${i}`));
      events.push(
        ev("m1", "qbr.shared", new Date(g.getTime() + mins * 60_000).toISOString(), `d${i}`),
      );
    });
    const lonely = ev("m1", "qbr.generated", "2026-11-04T09:00:00Z", "d9");
    events.push(lonely);
    const r = run(events);
    const median = fig(r, "m1", "qbrPrepMedian");
    expect(median.value).toBe(20);
    expect(median.unit).toBe("minutes");
    expect(median.sources.ids).toHaveLength(6);
    expect(median.sources.ids).not.toContain(lonely.id);
    expect(fig(r, "m1", "qbrPrepP90").value).toBe(90);
    expect(fig(r, "m1", "briefPrepMedian").value).toBeNull();
  });

  it("uses the earliest generated and the first share at or after it; a share before generation is not a pair", () => {
    const early = ev("m1", "brief.shared", "2026-11-03T08:00:00Z", "d1");
    const g = ev("m1", "brief.generated", "2026-11-03T09:00:00Z", "d1");
    const s1 = ev("m1", "brief.shared", "2026-11-03T09:30:00Z", "d1");
    const s2 = ev("m1", "brief.shared", "2026-11-03T12:00:00Z", "d1");
    const r = run([early, g, s1, s2]);
    expect(fig(r, "m1", "briefPrepMedian").value).toBe(30);
  });

  it("buckets weeks by the workspace timezone", () => {
    // 2026-11-02T01:00Z is still Sunday 1 Nov in New York (week 44)
    const e = ev("m1", "today.opened", "2026-11-02T01:00:00Z");
    const r = computePilotMetrics({
      events: [e],
      members: [M1],
      weeks: 4,
      asOf: AS_OF,
      timezone: "America/New_York",
    });
    expect(r.members[0]!.weekly["2026-W44"]!.todayOpens.value).toBe(1);
    expect(r.members[0]!.weekly["2026-W45"]!.todayOpens.value).toBe(0);
  });
});
