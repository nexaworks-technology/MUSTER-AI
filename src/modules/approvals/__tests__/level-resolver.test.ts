import { describe, expect, it } from "vitest";
import { DEFAULT_LEVELS, minLevel, resolveLevel } from "../level-resolver";

/**
 * effective = min(step level for the tier, workspace ceiling, sensitive cap) (ARCHITECTURE §7.3).
 * Customer contact never runs at DO_AUTOMATICALLY; auto-send needs a safe long-tail step, an
 * enabled switch and no sensitive topic. The sensitive cap wins over everything.
 */
describe("approval-level resolver", () => {
  it("orders levels lowest first", () => {
    expect(minLevel("SEND_AUTOMATICALLY", "DRAFT_FOR_APPROVAL")).toBe("DRAFT_FOR_APPROVAL");
    expect(minLevel("NOTIFY_ONLY", "DO_AUTOMATICALLY")).toBe("NOTIFY_ONLY");
  });

  it("tier defaults: customer-facing drafts need approval on every tier", () => {
    for (const tier of ["HIGH_TOUCH", "MID_TOUCH", "LONG_TAIL"] as const)
      expect(
        resolveLevel({
          tier,
          customerFacing: true,
          workspaceCeiling: "SEND_AUTOMATICALLY",
          isSensitive: false,
          autoSendEnabled: false,
        }),
      ).toBe("DRAFT_FOR_APPROVAL");
    expect(DEFAULT_LEVELS.customerFacing.HIGH_TOUCH).toBe("DRAFT_FOR_APPROVAL");
  });

  it("tier defaults: internal steps run automatically on mid-touch, need approval on high-touch", () => {
    const r = (tier: "HIGH_TOUCH" | "MID_TOUCH") =>
      resolveLevel({
        tier,
        customerFacing: false,
        workspaceCeiling: "SEND_AUTOMATICALLY",
        isSensitive: false,
        autoSendEnabled: false,
      });
    expect(r("MID_TOUCH")).toBe("DO_AUTOMATICALLY");
    expect(r("HIGH_TOUCH")).toBe("DRAFT_FOR_APPROVAL");
  });

  it("the workspace ceiling lowers a level", () => {
    expect(
      resolveLevel({
        tier: "MID_TOUCH",
        customerFacing: false,
        workspaceCeiling: "NOTIFY_ONLY",
        isSensitive: false,
        autoSendEnabled: false,
      }),
    ).toBe("NOTIFY_ONLY");
  });

  it("auto-send only for a safe long-tail step with the switch on", () => {
    const base = {
      tier: "LONG_TAIL" as const,
      customerFacing: true,
      workspaceCeiling: "SEND_AUTOMATICALLY" as const,
      isSensitive: false,
    };
    expect(
      resolveLevel({
        ...base,
        autoSendEnabled: true,
        stepLevel: "SEND_AUTOMATICALLY",
        safeStep: true,
      }),
    ).toBe("SEND_AUTOMATICALLY");
    expect(
      resolveLevel({
        ...base,
        autoSendEnabled: false,
        stepLevel: "SEND_AUTOMATICALLY",
        safeStep: true,
      }),
    ).toBe("DRAFT_FOR_APPROVAL");
    expect(
      resolveLevel({
        ...base,
        autoSendEnabled: true,
        stepLevel: "SEND_AUTOMATICALLY",
        safeStep: false,
      }),
    ).toBe("DRAFT_FOR_APPROVAL");
    expect(
      resolveLevel({
        ...base,
        tier: "MID_TOUCH",
        autoSendEnabled: true,
        stepLevel: "SEND_AUTOMATICALLY",
        safeStep: true,
      }),
    ).toBe("DRAFT_FOR_APPROVAL");
  });

  it("customer contact never resolves to DO_AUTOMATICALLY or a mailbox draft in M4", () => {
    const base = {
      tier: "LONG_TAIL" as const,
      customerFacing: true,
      workspaceCeiling: "SEND_AUTOMATICALLY" as const,
      isSensitive: false,
      autoSendEnabled: true,
    };
    expect(resolveLevel({ ...base, stepLevel: "DO_AUTOMATICALLY" })).toBe("DRAFT_FOR_APPROVAL");
    expect(resolveLevel({ ...base, stepLevel: "DRAFT_IN_MAILBOX" })).toBe("DRAFT_FOR_APPROVAL");
  });

  it("the sensitive cap wins over every setting", () => {
    expect(
      resolveLevel({
        tier: "LONG_TAIL",
        customerFacing: true,
        workspaceCeiling: "SEND_AUTOMATICALLY",
        isSensitive: true,
        autoSendEnabled: true,
        stepLevel: "SEND_AUTOMATICALLY",
        safeStep: true,
      }),
    ).toBe("DRAFT_FOR_APPROVAL");
    expect(
      resolveLevel({
        tier: "MID_TOUCH",
        customerFacing: false,
        workspaceCeiling: "DO_AUTOMATICALLY",
        isSensitive: true,
        autoSendEnabled: false,
      }),
    ).toBe("DRAFT_FOR_APPROVAL");
  });
});
