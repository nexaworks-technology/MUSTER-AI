import { describe, expect, it } from "vitest";
import { NAV, visibleNav } from "../features";

const member = (role: "ADMIN" | "CSM" | "VIEWER") => ({
  role,
  canViewRevenue: false,
  bookScope: "OWN" as const,
});

describe("navigation gating (Rule 6: no coming-soon screens)", () => {
  it("uses the spec's screen names", () => {
    expect(NAV.map((n) => n.label)).toEqual(
      expect.arrayContaining([
        "Today",
        "Approvals",
        "Accounts",
        "Health",
        "Renewals",
        "Ask AI",
        "Customers",
        "Settings",
      ]),
    );
  });

  it("shows only shipped screens in M1: Home for everyone, Settings for admins", () => {
    expect(visibleNav(member("ADMIN")).map((n) => n.label)).toEqual(["Home", "Settings"]);
    expect(visibleNav(member("CSM")).map((n) => n.label)).toEqual(["Home"]);
    expect(visibleNav(member("VIEWER")).map((n) => n.label)).toEqual(["Home"]);
  });

  it("never shows an item without a real route, even if its milestone number has passed", () => {
    expect(visibleNav(member("ADMIN"), 12).every((n) => typeof n.href === "string")).toBe(true);
  });
});
