import { describe, expect, it } from "vitest";
import { NAV, SHIPPED_MILESTONE, visibleNav } from "../features";

const member = (role: "ADMIN" | "CS_LEADER" | "CSM" | "VIEWER") => ({
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

  // Founder decision 3 (M3, D-54): one fixed, exact nav list per role for each milestone. A later
  // milestone adds a row and never edits an existing one; every row stays an exact-list match.
  // (Replaces the M2 form of these assertions, which C1 approved; the M1 and M2 rows below carry
  // exactly the lists those assertions held.)
  const NAV_BY_MILESTONE = {
    1: {
      ADMIN: ["Home", "Settings"],
      CS_LEADER: ["Home", "Settings"],
      CSM: ["Home"],
      VIEWER: ["Home"],
    },
    2: {
      ADMIN: ["Home", "Accounts", "Tasks", "Settings"],
      CS_LEADER: ["Home", "Accounts", "Tasks", "Settings"],
      CSM: ["Home", "Accounts", "Tasks"],
      VIEWER: ["Home", "Accounts", "Tasks"],
    },
    3: {
      ADMIN: ["Home", "Accounts", "Tasks", "Health", "Settings"],
      CS_LEADER: ["Home", "Accounts", "Tasks", "Health", "Settings"],
      CSM: ["Home", "Accounts", "Tasks", "Health"],
      VIEWER: ["Home", "Accounts", "Tasks", "Health"],
    },
    4: {
      ADMIN: ["Home", "Today", "Approvals", "Accounts", "Tasks", "Health", "Settings"],
      CS_LEADER: ["Home", "Today", "Approvals", "Accounts", "Tasks", "Health", "Settings"],
      CSM: ["Home", "Today", "Approvals", "Accounts", "Tasks", "Health"],
      VIEWER: ["Home", "Today", "Accounts", "Tasks", "Health"],
    },
    // M5 adds no top-level screen: integrations and the setup wizard live under Settings.
    5: {
      ADMIN: ["Home", "Today", "Approvals", "Accounts", "Tasks", "Health", "Settings"],
      CS_LEADER: ["Home", "Today", "Approvals", "Accounts", "Tasks", "Health", "Settings"],
      CSM: ["Home", "Today", "Approvals", "Accounts", "Tasks", "Health"],
      VIEWER: ["Home", "Today", "Accounts", "Tasks", "Health"],
    },
    // M6 adds Onboarding for every role (it lists the member's own book).
    6: {
      ADMIN: [
        "Home",
        "Today",
        "Approvals",
        "Accounts",
        "Tasks",
        "Health",
        "Onboarding",
        "Settings",
      ],
      CS_LEADER: [
        "Home",
        "Today",
        "Approvals",
        "Accounts",
        "Tasks",
        "Health",
        "Onboarding",
        "Settings",
      ],
      CSM: ["Home", "Today", "Approvals", "Accounts", "Tasks", "Health", "Onboarding"],
      VIEWER: ["Home", "Today", "Accounts", "Tasks", "Health", "Onboarding"],
    },
    // M7 adds Renewals and Expansion for every role; Revenue shows only with revenue access.
    7: {
      ADMIN: [
        "Home",
        "Today",
        "Approvals",
        "Accounts",
        "Tasks",
        "Health",
        "Onboarding",
        "Renewals",
        "Expansion",
        "Settings",
      ],
      CS_LEADER: [
        "Home",
        "Today",
        "Approvals",
        "Accounts",
        "Tasks",
        "Health",
        "Onboarding",
        "Renewals",
        "Expansion",
        "Settings",
      ],
      CSM: [
        "Home",
        "Today",
        "Approvals",
        "Accounts",
        "Tasks",
        "Health",
        "Onboarding",
        "Renewals",
        "Expansion",
      ],
      VIEWER: [
        "Home",
        "Today",
        "Accounts",
        "Tasks",
        "Health",
        "Onboarding",
        "Renewals",
        "Expansion",
      ],
    },
    // M8 adds Plays for every role (/campaigns is a tab on Plays, no separate nav entry).
    8: {
      ADMIN: [
        "Home",
        "Today",
        "Approvals",
        "Accounts",
        "Tasks",
        "Health",
        "Onboarding",
        "Renewals",
        "Expansion",
        "Plays",
        "Settings",
      ],
      CS_LEADER: [
        "Home",
        "Today",
        "Approvals",
        "Accounts",
        "Tasks",
        "Health",
        "Onboarding",
        "Renewals",
        "Expansion",
        "Plays",
        "Settings",
      ],
      CSM: [
        "Home",
        "Today",
        "Approvals",
        "Accounts",
        "Tasks",
        "Health",
        "Onboarding",
        "Renewals",
        "Expansion",
        "Plays",
      ],
      VIEWER: [
        "Home",
        "Today",
        "Accounts",
        "Tasks",
        "Health",
        "Onboarding",
        "Renewals",
        "Expansion",
        "Plays",
      ],
    },
  } as const;

  for (const [milestone, roles] of Object.entries(NAV_BY_MILESTONE))
    for (const [role, labels] of Object.entries(roles))
      it(`milestone ${milestone}: ${role} sees exactly ${labels.join(", ")}`, () => {
        expect(
          visibleNav(member(role as keyof typeof roles), Number(milestone)).map((n) => n.label),
        ).toEqual(labels);
      });

  it("Revenue (M7) shows only to a member with revenue access, whatever the role", () => {
    const labels = (canViewRevenue: boolean, role: "CSM" | "VIEWER") =>
      visibleNav({ ...member(role), canViewRevenue }, 7).map((n) => n.label);
    expect(labels(true, "CSM")).toContain("Revenue");
    expect(labels(true, "VIEWER")).toContain("Revenue");
    expect(labels(false, "CSM")).not.toContain("Revenue");
  });

  it("the shipped milestone shows the latest row", () => {
    const latest = Math.max(
      ...Object.keys(NAV_BY_MILESTONE).map(Number),
    ) as keyof typeof NAV_BY_MILESTONE;
    expect(SHIPPED_MILESTONE).toBe(latest);
    expect(visibleNav(member("ADMIN")).map((n) => n.label)).toEqual(NAV_BY_MILESTONE[latest].ADMIN);
  });

  it("never shows an item without a real route, even if its milestone number has passed", () => {
    expect(visibleNav(member("ADMIN"), 12).every((n) => typeof n.href === "string")).toBe(true);
  });
});
