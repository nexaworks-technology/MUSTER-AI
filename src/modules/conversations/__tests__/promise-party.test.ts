import { describe, expect, it } from "vitest";
import { promiseParty } from "../promise-party";

const people = { members: ["Leo Marsh", "Aisha Bello"], contacts: ["Dora Lindqvist", "Sam Reyes"] };
const call = (line: string) =>
  `Title: QBR\nDate: 2026-10-15\n\nSam Reyes: Hello.\n${line}\nDora Lindqvist: Thanks.`;

describe("promiseParty — decided by code from the source (D11)", () => {
  it("an outbound message is ours", () => {
    expect(
      promiseParty({ sourceType: "MESSAGE", direction: "OUTBOUND", quote: "I will send it", sourceText: "I will send it", ...people }),
    ).toMatchObject({ party: "US", suggestedParty: null });
  });

  it("an inbound message is the customer's", () => {
    expect(
      promiseParty({ sourceType: "MESSAGE", direction: "INBOUND", quote: "We will pay Friday", sourceText: "We will pay Friday", ...people }).party,
    ).toBe("CUSTOMER");
  });

  it("a transcript line spoken by a member is ours", () => {
    const line = "Leo Marsh: Engineering will have the API limit increase live by October 30.";
    const r = promiseParty({ sourceType: "CALL_TRANSCRIPT", quote: "Engineering will have the API limit increase live by October 30.", sourceText: call(line), ...people });
    expect(r).toMatchObject({ party: "US" });
    expect(r.reason).toContain("Leo Marsh");
  });

  it("a transcript line spoken by a contact is the customer's", () => {
    const line = "Dora Lindqvist: We will sign the order form once the limits are fixed.";
    expect(
      promiseParty({ sourceType: "CALL_TRANSCRIPT", quote: "We will sign the order form once the limits are fixed.", sourceText: call(line), ...people }).party,
    ).toBe("CUSTOMER");
  });

  it("speaker matching ignores case and extra spaces but never matches a first name alone", () => {
    const line = "leo   marsh: I'll send the guide tomorrow.";
    expect(
      promiseParty({ sourceType: "CALL_TRANSCRIPT", quote: "I'll send the guide tomorrow.", sourceText: call(line), ...people }).party,
    ).toBe("US");
    const first = "Leo: I'll send the guide tomorrow.";
    expect(
      promiseParty({ sourceType: "CALL_TRANSCRIPT", quote: "I'll send the guide tomorrow.", sourceText: call(first), ...people }).party,
    ).toBe("UNCLEAR");
  });

  it("an unknown speaker is not clear from the text", () => {
    const line = "Pat Quinn: We will look into it.";
    const r = promiseParty({ sourceType: "CALL_TRANSCRIPT", quote: "We will look into it.", sourceText: call(line), ...people });
    expect(r.party).toBe("UNCLEAR");
    expect(r.reason).toBe("Not clear from the text");
  });

  it("a name that is both a member and a contact is not decided", () => {
    const line = "Sam Reyes: I'll do it.";
    expect(
      promiseParty({ sourceType: "CALL_TRANSCRIPT", quote: "I'll do it.", sourceText: call(line), members: ["Sam Reyes"], contacts: ["Sam Reyes"] }).party,
    ).toBe("UNCLEAR");
  });

  it("a quote that is not on any speaker line is not decided", () => {
    const r = promiseParty({ sourceType: "CALL_TRANSCRIPT", quote: "not in there", sourceText: call("Leo Marsh: hi"), ...people });
    expect(r.party).toBe("UNCLEAR");
  });

  it("a note says who wrote it, not who promised: not clear unless told", () => {
    expect(promiseParty({ sourceType: "NOTE", quote: "will fix", sourceText: "will fix", ...people }).party).toBe("UNCLEAR");
  });

  it("the model's guess is only a flagged suggestion, and only when the text is not clear", () => {
    const unclear = promiseParty({ sourceType: "NOTE", quote: "will fix", sourceText: "will fix", modelGuess: "customer", ...people });
    expect(unclear).toMatchObject({ party: "UNCLEAR", suggestedParty: "CUSTOMER" });
    const decided = promiseParty({ sourceType: "MESSAGE", direction: "OUTBOUND", quote: "x", sourceText: "x", modelGuess: "customer", ...people });
    expect(decided).toMatchObject({ party: "US", suggestedParty: null });
  });
});
