import { describe, expect, it } from "vitest";
import { runComponent } from "../engine/components";
import type { AccountBundle } from "../engine/types";

/**
 * The Sentiment pillar fed by verified extraction labels (M4 §2, D-75, D-77): AI labels are data,
 * the score is a formula; fewer than 2 labelled customer ticket messages = not enough data, which
 * never lowers the score. Only inbound ticket messages in the last 90 days count.
 */
const ASOF = "2026-11-02";
type Msg = NonNullable<AccountBundle["messages"]>[number];
const msg = (
  id: string,
  date: string,
  label?: Msg["sentimentLabel"],
  o: Partial<Msg> = {},
): Msg => ({
  id,
  conversationId: `c-${id}`,
  channel: "TICKET",
  direction: "INBOUND",
  date,
  fromContactId: "k1",
  isBounce: false,
  ...(label ? { sentimentLabel: label } : {}),
  ...o,
});
const bundle = (messages: Msg[] | null): AccountBundle => ({
  accountId: "a1",
  asOf: ASOF,
  tier: "MID_TOUCH",
  plan: "Growth",
  employeeBand: "51-200",
  useCase: null,
  usage: null,
  ownBaseline: null,
  cohort: null,
  userUsage: null,
  featureUsage: null,
  keyFeatures: [],
  contract: null,
  messages,
  workspaceHasTickets: true,
  tickets: [],
  contacts: [],
  roles: [],
  invoices: [],
  revenueEvents: [],
  pulse: null,
});
const run = (b: AccountBundle) => runComponent("SENTIMENT", "sentiment_share", b);

describe("sentiment_share", () => {
  it("scores the share of negative (mixed = half) labelled ticket messages, citing each message", () => {
    const r = run(
      bundle([
        msg("m1", "2026-10-30", "NEGATIVE"),
        msg("m2", "2026-10-20", "NEGATIVE"),
        msg("m3", "2026-10-10", "MIXED"),
        msg("m4", "2026-09-30", "POSITIVE"),
      ]),
    );
    expect(r.score).toBeCloseTo(37.5, 4);
    expect(r.reason).toMatchObject({
      kind: "EVIDENCE",
      value: 0.625,
      periodStart: "2026-08-05",
      periodEnd: ASOF,
      message:
        "2 of 4 customer ticket messages in the last 90 days read as negative and 1 as mixed (AI labels, each checked against a quote from the message).",
      sources: ["m1", "m2", "m3", "m4"].map((id) => ({ sourceType: "Message", sourceId: id })),
    });
  });

  it("no labels, or only one, is not enough data and never lowers the score", () => {
    for (const messages of [
      null,
      [],
      [msg("m1", "2026-10-30")],
      [msg("m1", "2026-10-30", "NEGATIVE")],
    ]) {
      const r = run(bundle(messages));
      expect(r.score).toBeNull();
      expect(r.reason.kind).toBe("MISSING_DATA");
    }
  });

  it("ignores outbound replies, email, and anything older than 90 days or after the as-of date", () => {
    const r = run(
      bundle([
        msg("in1", "2026-10-30", "POSITIVE"),
        msg("in2", "2026-10-29", "NEUTRAL"),
        msg("out", "2026-10-30", "NEGATIVE", { direction: "OUTBOUND" }),
        msg("email", "2026-10-30", "NEGATIVE", { channel: "EMAIL" }),
        msg("old", "2026-08-01", "NEGATIVE"),
        msg("future", "2026-11-05", "NEGATIVE"),
      ]),
    );
    expect(r.score).toBe(100);
    expect(r.reason.sources).toEqual([
      { sourceType: "Message", sourceId: "in1" },
      { sourceType: "Message", sourceId: "in2" },
    ]);
  });
});
