import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_GRACE_DAYS,
  checkpointDue,
  classifyAlarm,
  decideCheckpoint,
  type CheckpointFacts,
  type LongStatus,
} from "../checkpoints";

/**
 * M11 S2 (test-first): the 30/90-day checkpoints are a deterministic comparison between what was
 * flagged (frozen prediction side) and what the records show by the checkpoint (outcome side).
 * Pure: no database. Precedence CHURNED > CONTRACTED > RENEWED/EXPANDED > RECOVERED >
 * MEETING_HELD > REPLIED > NO_CHANGE. Missing data → NO_CHANGE with evidence [] (not a failure).
 */
const T = (iso: string) => new Date(iso);

function facts(over: Partial<CheckpointFacts> = {}): CheckpointFacts {
  return {
    day: 30,
    signalId: "sig1",
    flagType: "RISK",
    flaggedAt: T("2026-06-01T10:00:00Z"),
    flaggedOn: "2026-06-01",
    dueOn: "2026-07-01",
    windowEnd: T("2026-07-02T00:00:00Z"),
    firstActionAt: null,
    messages: [],
    meetings: [],
    snapshots: [],
    renewalOutcomes: [],
    revenueEvents: [],
    ...over,
  };
}

describe("decideCheckpoint", () => {
  it("no data at all → NO_CHANGE with evidence [] and IGNORED", () => {
    const cp = decideCheckpoint(facts());
    expect(cp.status).toBe("NO_CHANGE");
    expect(cp.evidence).toEqual([]);
    expect(cp.actionTaken).toBe("IGNORED");
    expect(cp.prediction).toEqual({
      signalId: "sig1",
      flagType: "RISK",
      flaggedAt: "2026-06-01T10:00:00.000Z",
      healthAtFlag: null,
    });
  });

  it("REPLIED needs an inbound message after the first action and inside the window", () => {
    const acted = T("2026-06-03T09:00:00Z");
    const before = decideCheckpoint(
      facts({ firstActionAt: acted, messages: [{ id: "m0", at: T("2026-06-02T09:00:00Z") }] }),
    );
    expect(before.status).toBe("NO_CHANGE");
    const noAction = decideCheckpoint(
      facts({ messages: [{ id: "m1", at: T("2026-06-05T09:00:00Z") }] }),
    );
    expect(noAction.status).toBe("NO_CHANGE");
    const late = decideCheckpoint(
      facts({ firstActionAt: acted, messages: [{ id: "m2", at: T("2026-07-02T00:00:01Z") }] }),
    );
    expect(late.status).toBe("NO_CHANGE");
    const ok = decideCheckpoint(
      facts({ firstActionAt: acted, messages: [{ id: "m3", at: T("2026-06-10T09:00:00Z") }] }),
    );
    expect(ok.status).toBe("REPLIED");
    expect(ok.actionTaken).toBe("ACTED");
    expect(ok.evidence).toEqual([{ sourceType: "Message", sourceId: "m3" }]);
  });

  it("an action after the window does not count as acted at this checkpoint", () => {
    const cp = decideCheckpoint(facts({ firstActionAt: T("2026-07-05T00:00:00Z") }));
    expect(cp.actionTaken).toBe("IGNORED");
  });

  it("MEETING_HELD needs a completed meeting after the first action; it outranks REPLIED", () => {
    const cp = decideCheckpoint(
      facts({
        firstActionAt: T("2026-06-03T09:00:00Z"),
        messages: [{ id: "m1", at: T("2026-06-04T09:00:00Z") }],
        meetings: [
          { id: "mt0", at: T("2026-06-02T09:00:00Z") },
          { id: "mt1", at: T("2026-06-12T09:00:00Z") },
        ],
      }),
    );
    expect(cp.status).toBe("MEETING_HELD");
    expect(cp.evidence).toEqual([{ sourceType: "Meeting", sourceId: "mt1" }]);
  });

  it("RECOVERED needs a better band that holds for the last 14 days of the window", () => {
    const snaps = [
      { id: "s0", on: "2026-05-30", riskLevel: "AT_RISK" },
      { id: "s1", on: "2026-06-10", riskLevel: "WATCH" },
      { id: "s2", on: "2026-06-20", riskLevel: "HEALTHY" },
    ];
    const cp = decideCheckpoint(facts({ snapshots: snaps }));
    expect(cp.status).toBe("RECOVERED");
    expect(cp.evidence.map((e) => e.sourceId)).toEqual(["s0", "s1", "s2"]);
    expect(cp.healthAtCheckpoint).toEqual({ snapshotId: "s2", riskLevel: "HEALTHY" });
  });

  it("RECOVERED is refused when the improvement is younger than 14 days at the checkpoint", () => {
    const snaps = [
      { id: "s0", on: "2026-05-30", riskLevel: "AT_RISK" },
      { id: "s1", on: "2026-06-20", riskLevel: "WATCH" },
    ];
    expect(decideCheckpoint(facts({ snapshots: snaps })).status).toBe("NO_CHANGE");
  });

  it("RECOVERED is refused when the band fell back inside the window", () => {
    const snaps = [
      { id: "s0", on: "2026-05-30", riskLevel: "AT_RISK" },
      { id: "s1", on: "2026-06-05", riskLevel: "HEALTHY" },
      { id: "s2", on: "2026-06-25", riskLevel: "AT_RISK" },
    ];
    expect(decideCheckpoint(facts({ snapshots: snaps })).status).toBe("NO_CHANGE");
  });

  it("RECOVERED needs a snapshot at the flag; with none it is not claimed", () => {
    const snaps = [{ id: "s1", on: "2026-06-05", riskLevel: "HEALTHY" }];
    expect(decideCheckpoint(facts({ snapshots: snaps })).status).toBe("NO_CHANGE");
  });

  it("snapshots after the checkpoint date are ignored", () => {
    const snaps = [
      { id: "s0", on: "2026-05-30", riskLevel: "AT_RISK" },
      { id: "s1", on: "2026-07-10", riskLevel: "HEALTHY" },
    ];
    const cp = decideCheckpoint(facts({ snapshots: snaps }));
    expect(cp.status).toBe("NO_CHANGE");
    expect(cp.healthAtCheckpoint).toEqual({ snapshotId: "s0", riskLevel: "AT_RISK" });
  });

  it("RENEWED / CHURNED come from renewal outcomes and revenue events; CHURNED outranks", () => {
    const renewed = decideCheckpoint(
      facts({
        day: 90,
        renewalOutcomes: [{ id: "r1", result: "RENEWED", on: "2026-06-20", supersedesId: null }],
      }),
    );
    expect(renewed.status).toBe("RENEWED");
    expect(renewed.evidence).toEqual([{ sourceType: "RenewalOutcome", sourceId: "r1" }]);
    const churned = decideCheckpoint(
      facts({
        renewalOutcomes: [{ id: "r1", result: "RENEWED", on: "2026-06-20", supersedesId: null }],
        revenueEvents: [{ id: "e1", type: "CHURN", on: "2026-06-25", deltaArrMinor: -100n }],
      }),
    );
    expect(churned.status).toBe("CHURNED");
    expect(churned.evidence).toEqual([{ sourceType: "RevenueEvent", sourceId: "e1" }]);
  });

  it("a superseded renewal outcome does not count; its correction does", () => {
    const cp = decideCheckpoint(
      facts({
        renewalOutcomes: [
          { id: "r1", result: "RENEWED", on: "2026-06-20", supersedesId: null },
          { id: "r2", result: "CHURNED", on: "2026-06-20", supersedesId: "r1" },
        ],
      }),
    );
    expect(cp.status).toBe("CHURNED");
    expect(cp.evidence).toEqual([{ sourceType: "RenewalOutcome", sourceId: "r2" }]);
  });

  it("CONTRACTED outranks RENEWED; EXPANDED only for opportunity flags", () => {
    const contracted = decideCheckpoint(
      facts({
        renewalOutcomes: [{ id: "r1", result: "RENEWED", on: "2026-06-20", supersedesId: null }],
        revenueEvents: [{ id: "e1", type: "CONTRACTION", on: "2026-06-21", deltaArrMinor: -5n }],
      }),
    );
    expect(contracted.status).toBe("CONTRACTED");
    const exp = [{ id: "e2", type: "EXPANSION" as const, on: "2026-06-21", deltaArrMinor: 50n }];
    expect(decideCheckpoint(facts({ revenueEvents: exp })).status).toBe("NO_CHANGE");
    expect(decideCheckpoint(facts({ flagType: "OPPORTUNITY", revenueEvents: exp })).status).toBe(
      "EXPANDED",
    );
  });

  it("revenue records outside the window are ignored", () => {
    const cp = decideCheckpoint(
      facts({
        renewalOutcomes: [{ id: "r1", result: "CHURNED", on: "2026-07-02", supersedesId: null }],
        revenueEvents: [{ id: "e1", type: "CHURN", on: "2026-05-31", deltaArrMinor: -1n }],
      }),
    );
    expect(cp.status).toBe("NO_CHANGE");
  });

  it("is labelled attributed, never causal (Q-15)", () => {
    const cp = decideCheckpoint(facts());
    expect(cp.attributed).toBe(true);
    expect(cp.note).toMatch(/not proven/i);
  });
});

describe("checkpointDue (business dates, grace)", () => {
  it(`is due ${CHECKPOINT_GRACE_DAYS} days after the business-date checkpoint, not before`, () => {
    // Flag on 2026-06-01 local → d30 dueOn 2026-07-01, evaluated from 2026-07-08.
    expect(checkpointDue("2026-06-01", 30, "2026-07-07")).toEqual({
      dueOn: "2026-07-01",
      due: false,
    });
    expect(checkpointDue("2026-06-01", 30, "2026-07-08")).toEqual({
      dueOn: "2026-07-01",
      due: true,
    });
    expect(checkpointDue("2026-06-01", 90, "2026-09-06")).toEqual({
      dueOn: "2026-08-30",
      due: true,
    });
  });
});

describe("classifyAlarm (Q-16 as founder-decided 2026-11-05, D-163)", () => {
  const d90 = (status: LongStatus, actionTaken: "ACTED" | "IGNORED", risk?: string) => ({
    status,
    actionTaken,
    healthAtCheckpoint: risk ? { snapshotId: "s", riskLevel: risk } : null,
  });
  it("opportunity flags are never classified", () => {
    expect(
      classifyAlarm({
        flagType: "OPPORTUNITY",
        signalStatus: "OPEN",
        d90: d90("CHURNED", "ACTED"),
      }),
    ).toBeNull();
  });
  it("churned or contracted by d90 → true alarm, even when marked false", () => {
    expect(
      classifyAlarm({ flagType: "RISK", signalStatus: "OPEN", d90: d90("CHURNED", "IGNORED") }),
    ).toBe(true);
    expect(
      classifyAlarm({
        flagType: "RISK",
        signalStatus: "FALSE_ALARM",
        d90: d90("CONTRACTED", "ACTED"),
      }),
    ).toBe(true);
  });
  it("marked FALSE_ALARM → false alarm", () => {
    expect(
      classifyAlarm({
        flagType: "RISK",
        signalStatus: "FALSE_ALARM",
        d90: d90("NO_CHANGE", "IGNORED"),
      }),
    ).toBe(false);
    expect(classifyAlarm({ flagType: "RISK", signalStatus: "FALSE_ALARM", d90: null })).toBe(false);
  });
  it("healthy at d90 and renewed with no action → false alarm", () => {
    expect(
      classifyAlarm({
        flagType: "RISK",
        signalStatus: "OPEN",
        d90: d90("RENEWED", "IGNORED", "HEALTHY"),
      }),
    ).toBe(false);
  });
  it("renewed after action, or renewed while not healthy → undetermined", () => {
    expect(
      classifyAlarm({
        flagType: "RISK",
        signalStatus: "OPEN",
        d90: d90("RENEWED", "ACTED", "HEALTHY"),
      }),
    ).toBeNull();
    expect(
      classifyAlarm({
        flagType: "RISK",
        signalStatus: "OPEN",
        d90: d90("RENEWED", "IGNORED", "WATCH"),
      }),
    ).toBeNull();
  });
  it("no d90 yet and not marked → undetermined", () => {
    expect(classifyAlarm({ flagType: "RISK", signalStatus: "OPEN", d90: null })).toBeNull();
  });
});
