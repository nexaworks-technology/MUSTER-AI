import { describe, expect, it } from "vitest";
import { labelOf, SENSITIVE_LABEL_KINDS } from "../labels";

describe("labelOf: what an extraction reads as in the product (never a score)", () => {
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    ["SENTIMENT", { label: "NEGATIVE" }, "Sentiment: negative", "negative"],
    ["SENTIMENT", { label: "MIXED" }, "Sentiment: mixed", "mixed"],
    ["INTENT", { intent: "complaint" }, "Intent: complaint", "neutral"],
    ["COMPETITOR", { competitorName: "Tallyfield" }, "Competitor: Tallyfield", "risk"],
    ["COMPLAINT", { theme: "csv_export" }, "Complaint: csv export", "risk"],
    ["THEME", { theme: "api_limits" }, "Theme: api limits", "neutral"],
    ["BUDGET_CONCERN", {}, "Budget concern", "risk"],
    ["CANCEL_LANGUAGE", {}, "Cancellation language", "risk"],
    ["EXPORT_LANGUAGE", {}, "Data-export language", "risk"],
    ["RENEWAL_CONCERN", {}, "Renewal concern", "risk"],
    ["PROMISE", { what: "CSV export fix" }, "Promise: CSV export fix", "neutral"],
    ["GOAL", { goal: "Cut close to 3 days" }, "Goal: Cut close to 3 days", "good"],
    ["ACTION_ITEM", { what: "Send the guide" }, "Action: Send the guide", "neutral"],
    ["DECISION", { decision: "Monthly check-ins" }, "Decision: Monthly check-ins", "neutral"],
  ];
  it.each(cases)("%s %j reads %s", (kind, payload, text, tone) => {
    expect(labelOf(kind as never, payload)).toEqual({ kind, text, tone });
  });
  it("positive sentiment is good", () => {
    expect(labelOf("SENTIMENT", { label: "POSITIVE" }).tone).toBe("good");
  });
  it("a missing payload field never invents text", () => {
    expect(labelOf("COMPETITOR", {}).text).toBe("Competitor");
    expect(labelOf("INTENT", {}).text).toBe("Intent");
  });
  it("lists the kinds that mark a message sensitive", () => {
    expect([...SENSITIVE_LABEL_KINDS].sort()).toEqual(["CANCEL_LANGUAGE", "COMPLAINT", "EXPORT_LANGUAGE"]);
  });
});
