import { describe, expect, it } from "vitest";
import type { LongCheckpoint } from "../checkpoints";
import {
  alarmOf,
  buildAccuracy,
  type AccuracyApproval,
  type AccuracyFlag,
  type AccuracyThresholds,
} from "../accuracy";

/**
 * M11 S5: AI accuracy. Alarm classification is `classifyAlarm` (D-163), never re-defined here;
 * rates are over determined alarms only, null (never 0) when there are none; "cries wolf" is
 * D-167: false-alarm rate strictly above the threshold with at least the minimum determined.
 */
const T: AccuracyThresholds = { criesWolfRate: 0.4, criesWolfMinDetermined: 5 };

const d90 = (
  status: string,
  actionTaken: "ACTED" | "IGNORED" = "ACTED",
  riskLevel: string | null = null,
): NonNullable<AccuracyFlag["d90"]> =>
  ({
    status,
    actionTaken,
    healthAtCheckpoint: riskLevel ? { riskLevel } : null,
  }) as unknown as Pick<LongCheckpoint, "status" | "actionTaken" | "healthAtCheckpoint">;

let seq = 0;
function flag(over: Partial<AccuracyFlag> = {}): AccuracyFlag {
  return {
    flagType: "RISK",
    signalStatus: "OPEN",
    isTrueAlarm: null,
    d90: null,
    ruleKey: "usage_drop_vs_normal",
    agentKey: null,
    outcomeRecordId: `r${++seq}`,
    signalId: `s${seq}`,
    accountId: `a${seq}`,
    flaggedAt: new Date("2026-10-01T00:00:00Z"),
    ...over,
  };
}
const trueFlag = (over: Partial<AccuracyFlag> = {}) => flag({ d90: d90("CHURNED"), ...over });
const falseFlag = (over: Partial<AccuracyFlag> = {}) =>
  flag({ signalStatus: "FALSE_ALARM", ...over });

describe("alarmOf (D-163 through classifyAlarm)", () => {
  it("true when the frozen d90 is churned or contracted", () => {
    expect(alarmOf(trueFlag())).toBe(true);
    expect(alarmOf(flag({ d90: d90("CONTRACTED") }))).toBe(true);
  });
  it("false when marked a false alarm, or healthy at d90, renewed, no action", () => {
    expect(alarmOf(falseFlag())).toBe(false);
    expect(alarmOf(flag({ d90: d90("RENEWED", "IGNORED", "HEALTHY") }))).toBe(false);
  });
  it("undetermined otherwise, and for opportunities", () => {
    expect(alarmOf(flag())).toBeNull();
    expect(alarmOf(flag({ d90: d90("RENEWED", "ACTED", "HEALTHY") }))).toBeNull();
    expect(alarmOf(flag({ flagType: "OPPORTUNITY", d90: d90("CHURNED") }))).toBeNull();
  });
  it("the frozen isTrueAlarm takes precedence when set", () => {
    expect(alarmOf(flag({ isTrueAlarm: true, signalStatus: "FALSE_ALARM" }))).toBe(true);
    expect(alarmOf(flag({ isTrueAlarm: false, d90: d90("CHURNED") }))).toBe(false);
  });
});

describe("buildAccuracy", () => {
  it("counts true, false and undetermined per rule; undetermined is excluded from the rate", () => {
    const { byRule } = buildAccuracy(
      [trueFlag(), falseFlag(), falseFlag(), flag(), flag(), flag()],
      [],
      T,
    );
    expect(byRule).toHaveLength(1);
    expect(byRule[0]).toMatchObject({
      key: "usage_drop_vs_normal",
      trueAlarms: 1,
      falseAlarms: 2,
      undetermined: 3,
      determined: 3,
    });
    expect(byRule[0]!.falseAlarmRate).toBeCloseTo(2 / 3);
  });

  it("the rate is null, not 0, when nothing is determined", () => {
    const { byRule } = buildAccuracy([flag(), flag()], [], T);
    expect(byRule[0]!.falseAlarmRate).toBeNull();
    expect(byRule[0]!.criesWolf).toBe(false);
  });

  it("ignores opportunity flags entirely", () => {
    const { byRule } = buildAccuracy([flag({ flagType: "OPPORTUNITY" })], [], T);
    expect(byRule).toEqual([]);
  });

  it("cries wolf: exactly 40% does not, 41% does, below the minimum n never does", () => {
    const mk = (f: number, t: number) => [
      ...Array.from({ length: f }, () => falseFlag()),
      ...Array.from({ length: t }, () => trueFlag()),
    ];
    expect(buildAccuracy(mk(2, 3), [], T).byRule[0]!.criesWolf).toBe(false); // 40%, n=5
    expect(buildAccuracy(mk(3, 3), [], T).byRule[0]!.criesWolf).toBe(true); // 50%
    const odd = buildAccuracy(mk(41, 59), [], T).byRule[0]!; // 41%, n=100
    expect(odd.falseAlarmRate).toBeCloseTo(0.41);
    expect(odd.criesWolf).toBe(true);
    expect(buildAccuracy(mk(4, 0), [], T).byRule[0]!.criesWolf).toBe(false); // 100%, n=4 < 5
    expect(buildAccuracy(mk(5, 0), [], T).byRule[0]!.criesWolf).toBe(true);
  });

  it("groups by rule and by agent separately", () => {
    const r = buildAccuracy(
      [
        trueFlag({ ruleKey: "a", agentKey: "watcher" }),
        falseFlag({ ruleKey: "b", agentKey: "watcher" }),
        falseFlag({ ruleKey: "b", agentKey: null }),
      ],
      [],
      T,
    );
    expect(r.byRule.map((x) => [x.key, x.trueAlarms, x.falseAlarms])).toEqual([
      ["a", 1, 0],
      ["b", 0, 2],
    ]);
    expect(r.byAgent).toHaveLength(1);
    expect(r.byAgent[0]).toMatchObject({ key: "watcher", trueAlarms: 1, falseAlarms: 1 });
  });

  it("acceptance rate = approved (incl. edited) / (approved + rejected); expired and pending excluded", () => {
    const ap = (status: string): AccuracyApproval => ({
      approvalId: `p${++seq}`,
      accountId: null,
      agentKey: "renewal-manager",
      status,
    });
    const { byAgent } = buildAccuracy(
      [],
      [
        ap("APPROVED"),
        ap("EDITED_APPROVED"),
        ap("REJECTED"),
        ap("EXPIRED"),
        ap("PENDING"),
        ap("APPROVED"),
      ],
      T,
    );
    expect(byAgent).toHaveLength(1);
    expect(byAgent[0]).toMatchObject({ key: "renewal-manager", approved: 3, rejected: 1 });
    expect(byAgent[0]!.acceptanceRate).toBeCloseTo(0.75);
  });

  it("acceptance rate is null when nobody has decided", () => {
    const { byAgent } = buildAccuracy(
      [],
      [{ approvalId: "p", accountId: null, agentKey: "x", status: "EXPIRED" }],
      T,
    );
    expect(byAgent[0]).toMatchObject({ approved: 0, rejected: 0, acceptanceRate: null });
  });

  it("each row's item lists have exactly as many items as its counts", () => {
    const r = buildAccuracy(
      [trueFlag({ agentKey: "w" }), falseFlag({ agentKey: "w" }), flag({ agentKey: "w" }), flag()],
      [
        { approvalId: "1", accountId: null, agentKey: "w", status: "APPROVED" },
        { approvalId: "2", accountId: null, agentKey: "w", status: "REJECTED" },
        { approvalId: "3", accountId: null, agentKey: "w", status: "EXPIRED" },
      ],
      T,
    );
    for (const row of [...r.byRule, ...r.byAgent]) {
      const n = (a: boolean | null) => row.flagItems.filter((i) => i.alarm === a).length;
      expect(n(true)).toBe(row.trueAlarms);
      expect(n(false)).toBe(row.falseAlarms);
      expect(n(null)).toBe(row.undetermined);
      expect(row.approvalItems).toHaveLength(row.approved + row.rejected);
    }
  });
});
