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

  // Approved change (M2, founder decision C1): the exact list grows as screens ship. These
  // assertions stay exact-list matches, updated per milestone, never loosened to "contains".
  it("shows exactly the shipped screens: M2 adds Accounts and Tasks", () => {
    expect(visibleNav(member("ADMIN")).map((n) => n.label)).toEqual([
      "Home",
      "Accounts",
      "Tasks",
      "Settings",
    ]);
    expect(visibleNav(member("CSM")).map((n) => n.label)).toEqual(["Home", "Accounts", "Tasks"]);
    expect(visibleNav(member("VIEWER")).map((n) => n.label)).toEqual(["Home", "Accounts", "Tasks"]);
  });

  it("M1 screens stay exactly as they were when only M1 has shipped", () => {
    expect(visibleNav(member("ADMIN"), 1).map((n) => n.label)).toEqual(["Home", "Settings"]);
    expect(visibleNav(member("CSM"), 1).map((n) => n.label)).toEqual(["Home"]);
  });

  it("never shows an item without a real route, even if its milestone number has passed", () => {
    expect(visibleNav(member("ADMIN"), 12).every((n) => typeof n.href === "string")).toBe(true);
  });
});
