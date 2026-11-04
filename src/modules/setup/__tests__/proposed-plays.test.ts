import { describe, expect, it } from "vitest";
import {
  proposePlaysForWorkspace,
  type WorkspaceSetupData,
} from "../proposed-plays";

describe("S15 Proposed Plays Rules (Pure Module - Deterministic, No LLM)", () => {
  it("proposes payment-failed play when a billing provider (Stripe/Chargebee) is connected", () => {
    const withBilling: WorkspaceSetupData = {
      connectedProviders: ["STRIPE"],
      hasAccounts: true,
      hasContracts: false,
      hasTiers: false,
      hasOnboarding: false,
    };
    const proposals = proposePlaysForWorkspace(withBilling);
    const keys = proposals.map((p) => p.playKey);

    expect(keys).toContain("payment-failed");
    const paymentProp = proposals.find((p) => p.playKey === "payment-failed");
    expect(paymentProp?.reason).toMatch(/billing/i);

    const withoutBilling: WorkspaceSetupData = {
      connectedProviders: ["SLACK"],
      hasAccounts: true,
      hasContracts: false,
      hasTiers: false,
      hasOnboarding: false,
    };
    expect(proposePlaysForWorkspace(withoutBilling).map((p) => p.playKey)).not.toContain("payment-failed");
  });

  it("proposes renewal plays when contracts or CRM are connected", () => {
    const withContracts: WorkspaceSetupData = {
      connectedProviders: [],
      hasAccounts: true,
      hasContracts: true,
      hasTiers: true,
      hasOnboarding: false,
    };
    const proposals = proposePlaysForWorkspace(withContracts);
    const keys = proposals.map((p) => p.playKey);

    expect(keys).toContain("renewal-risk");
    expect(keys).toContain("renewal-window");
  });

  it("proposes onboarding plays when onboarding accounts exist", () => {
    const withOnboarding: WorkspaceSetupData = {
      connectedProviders: [],
      hasAccounts: true,
      hasContracts: false,
      hasTiers: false,
      hasOnboarding: true,
    };
    const proposals = proposePlaysForWorkspace(withOnboarding);
    const keys = proposals.map((p) => p.playKey);

    expect(keys).toContain("onboarding-stall");
    expect(keys).toContain("customer-handoff");
  });

  it("never proposes dormant plays (promise-late, qbr-due, engagement-loss, business-review-followup)", () => {
    const fullWorkspace: WorkspaceSetupData = {
      connectedProviders: ["STRIPE", "HUBSPOT", "SALESFORCE", "SLACK", "CHARGEBEE"],
      hasAccounts: true,
      hasContracts: true,
      hasTiers: true,
      hasOnboarding: true,
    };
    const proposals = proposePlaysForWorkspace(fullWorkspace);
    const keys = proposals.map((p) => p.playKey);

    expect(keys).not.toContain("promise-late");
    expect(keys).not.toContain("qbr-due");
    expect(keys).not.toContain("engagement-loss");
    expect(keys).not.toContain("business-review-followup");
  });

  it("is completely deterministic with plain-English reasons for each proposal", () => {
    const data: WorkspaceSetupData = {
      connectedProviders: ["HUBSPOT", "STRIPE"],
      hasAccounts: true,
      hasContracts: true,
      hasTiers: true,
      hasOnboarding: true,
    };

    const run1 = proposePlaysForWorkspace(data);
    const run2 = proposePlaysForWorkspace(data);

    expect(run1).toEqual(run2);
    for (const p of run1) {
      expect(p.reason).toBeTruthy();
      expect(typeof p.reason).toBe("string");
    }
  });
});
