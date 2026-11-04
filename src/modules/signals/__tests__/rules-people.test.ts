import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { championState, type AccountBundle } from "@/modules/health/service";
import { evaluateRule, type SignalBundle } from "../rules";

/**
 * M9 people rules: `champion_silent` must never define "silent" a second way (D-119). Swept over
 * every silent-day count it agrees with `championState`, and the threshold is exactly N: N−1 days
 * is quiet-but-fine, N days is silent.
 */
const ASOF = "2026-11-02";
const bundle = (lastInboundDaysAgo: number | null): SignalBundle =>
  ({
    accountId: "a1",
    asOf: ASOF,
    contacts: [{ id: "maya", name: "Maya Ortiz", status: "ACTIVE", statusDate: null }],
    roles: [
      { id: "r1", contactId: "maya", role: "CHAMPION", validFrom: "2025-01-01", validTo: null },
    ],
    messages:
      lastInboundDaysAgo === null
        ? []
        : [
            {
              id: "m1",
              conversationId: "cv",
              channel: "EMAIL",
              direction: "INBOUND",
              date: addDays(ASOF, -lastInboundDaysAgo),
              fromContactId: "maya",
              isBounce: false,
            },
          ],
    userUsage: null,
  }) as unknown as SignalBundle;

describe("champion_silent is exactly championState (no second definition)", () => {
  it("agrees with championState for every silent-day count from 0 to 75, at the default and at a custom threshold", () => {
    for (const threshold of [30, 14])
      for (let days = 0; days <= 75; days++) {
        const b = bundle(days);
        const silent = championState(b as AccountBundle, threshold)?.state === "SILENT";
        const fires =
          evaluateRule("champion_silent", b, { silentAfterDays: threshold, criticalAfterDays: 90 })
            .length > 0;
        expect({ threshold, days, fires }).toEqual({ threshold, days, fires: silent });
      }
  });

  it("N−1 days is not silent, N days is", () => {
    expect(evaluateRule("champion_silent", bundle(29), {})).toHaveLength(0);
    expect(evaluateRule("champion_silent", bundle(30), {})).toHaveLength(1);
  });

  it("the signal's evidence names the champion's contact record with the silent days and the day last heard", () => {
    const [c] = evaluateRule("champion_silent", bundle(41), {});
    expect(c!.evidence).toContainEqual(
      expect.objectContaining({
        sourceType: "Contact",
        sourceId: "maya",
        value: 41,
        date: addDays(ASOF, -41),
      }),
    );
  });

  it("never fires without a champion on record (Rule 4: missing data is not bad news)", () => {
    const b = { ...bundle(null), roles: [] } as unknown as SignalBundle;
    expect(evaluateRule("champion_silent", b, {})).toEqual([]);
  });
});
