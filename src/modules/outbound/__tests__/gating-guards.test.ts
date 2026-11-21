import { describe, expect, it } from "vitest";
import { GUARDS, checkGates, gatingGuards } from "../guards";

/**
 * Which recorded checks stop a send (DEMO-WALKTHROUGH note: a person-approved send listed
 * "Not passed: quiet hours" beside "sent", reading like a failure). Dispatch and the Approvals page
 * read this one rule, so the label cannot disagree with what was enforced.
 */
describe("gatingGuards", () => {
  it("a person-approved email is stopped only by suppression among the guards", () => {
    const g = gatingGuards({ sendMode: "APPROVED", sourceKey: null });
    expect(g).toEqual(["suppressed"]);
    expect(checkGates("quiet_hours", g)).toBe(false);
    expect(checkGates("auto_send_disabled", g)).toBe(false);
    expect(checkGates("suppressed", g)).toBe(true);
  });
  it("a pre-check (not an auto-send guard) always stops the send", () => {
    expect(
      checkGates("approval_approved", gatingGuards({ sendMode: "APPROVED", sourceKey: null })),
    ).toBe(true);
  });
  it("automatic sends are stopped by every guard; surveys and campaigns by their own sets", () => {
    expect(gatingGuards({ sendMode: "AUTO", sourceKey: null })).toEqual(GUARDS);
    expect(gatingGuards({ sendMode: "APPROVED", sourceKey: "survey:x" })).toContain("quiet_hours");
    expect(gatingGuards({ sendMode: "CAMPAIGN", sourceKey: null })).not.toContain(
      "auto_send_disabled",
    );
  });
});
