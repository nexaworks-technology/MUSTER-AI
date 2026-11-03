import { describe, expect, it } from "vitest";
import { detectSensitive } from "../sensitive";

/**
 * The sensitive-topic detector (ARCHITECTURE §7.4 guard 6, spec §6J4, CLAUDE.md Rule 3).
 * Conservative by design: a false positive costs one human review; a false negative could
 * auto-send to an unhappy customer. Over-flagging is accepted, so these tests check recall and
 * only a few obvious non-hits.
 */
describe("detectSensitive", () => {
  it.each([
    ["How do I export all our data before we cancel at the end of the term?", "cancellation"],
    ["We would like a refund for last month.", "pricing"],
    ["Your price increase is not acceptable to us.", "pricing"],
    ["Can we discuss a discount on renewal?", "pricing"],
    ["I have forwarded this to our lawyer.", "legal"],
    ["Please review the contract terms with our counsel.", "legal"],
    ["We had a security incident last night.", "security"],
    ["Is this a data breach? We need a GDPR answer.", "security"],
    ["I want to file a complaint about support.", "complaint"],
    ["Please escalate this to your VP.", "escalation"],
  ])("%s → %s", (text, reason) => {
    const r = detectSensitive({ texts: [text] });
    expect(r.isSensitive).toBe(true);
    expect(r.reasons).toContain(reason);
  });

  it("matches whole words, any case, across the triggering text and the draft", () => {
    expect(detectSensitive({ texts: ["Fine", "We may CANCEL."] }).reasons).toEqual([
      "cancellation",
    ]);
    expect(detectSensitive({ texts: ["Our scancel tool works"] }).isSensitive).toBe(false);
  });

  it("an INTENT / CANCEL_LANGUAGE / COMPLAINT extraction flags it, even with neutral words", () => {
    expect(
      detectSensitive({ texts: ["Quick question"], extractions: [{ kind: "CANCEL_LANGUAGE" }] })
        .reasons,
    ).toEqual(["cancellation"]);
    expect(detectSensitive({ texts: [""], extractions: [{ kind: "COMPLAINT" }] }).reasons).toEqual([
      "complaint",
    ]);
    expect(
      detectSensitive({
        texts: [""],
        extractions: [{ kind: "INTENT", payload: { intent: "pricing" } }],
      }).reasons,
    ).toEqual(["pricing"]);
  });

  it("a sensitive step tag flags it", () => {
    expect(detectSensitive({ texts: ["Hi"], stepTags: ["legal"] }).reasons).toEqual(["legal"]);
  });

  it("collects every reason, once each, in a fixed order", () => {
    expect(
      detectSensitive({ texts: ["Cancel or I call my lawyer; complaint attached. Cancel now."] })
        .reasons,
    ).toEqual(["cancellation", "legal", "complaint"]);
  });

  it("plain check-in text is not sensitive", () => {
    const r = detectSensitive({
      texts: [
        "Hi Maya, I noticed fewer of your team used the dashboards this month. Want a quick walkthrough?",
      ],
    });
    expect(r).toEqual({ isSensitive: false, reasons: [], matches: [] });
  });
});
