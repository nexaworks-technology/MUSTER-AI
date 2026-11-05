import { describe, expect, it } from "vitest";
import { teamActivityReport, type TeamActivityInput } from "../team-activity";
import { everyFigureIsProven, fig } from "./helpers";

const input: TeamActivityInput = {
  baseCurrency: "USD",
  query: "",
  members: [
    { id: "m1", name: "Priya" },
    { id: "m2", name: "Sam" },
  ],
  accounts: [
    { id: "a1", ownerMembershipId: "m1", arrMinor: 100_00n, currency: "USD" },
    { id: "a2", ownerMembershipId: "m1", arrMinor: null, currency: null },
    { id: "a3", ownerMembershipId: "m2", arrMinor: 40_00n, currency: "USD" },
    { id: "a4", ownerMembershipId: null, arrMinor: 5_00n, currency: "USD" },
  ],
  openTasks: [
    { id: "t1", accountId: "a1", ownerMembershipId: "m1" },
    { id: "t2", accountId: "a1", ownerMembershipId: "m1" },
  ],
  doneTasks: [{ id: "t3", accountId: "a3", ownerMembershipId: "m2" }],
  decidedApprovals: [
    { id: "ap1", accountId: "a1", decidedById: "m1" },
    { id: "ap2", accountId: "a3", decidedById: "m1" },
  ],
  outcomes: [
    { id: "r1", accountId: "a1", d90Status: "RENEWED" },
    { id: "r2", accountId: "a1", d90Status: "CHURNED" },
    { id: "r3", accountId: "a2", d90Status: null },
    { id: "r4", accountId: "a3", d90Status: "RECOVERED" },
  ],
};

describe("team activity vs outcomes", () => {
  const r = teamActivityReport(input);

  it("shows each owner's activity next to their outcomes", () => {
    expect(fig(r, "Priya: open tasks").sources.ids).toEqual(["t1", "t2"]);
    expect(fig(r, "Priya: approvals decided").sources.ids).toEqual(["ap1", "ap2"]);
    expect(fig(r, "Sam: tasks completed in the period").sources.ids).toEqual(["t3"]);
    expect(fig(r, "Priya: flags that ended renewed or recovered").sources.ids).toEqual(["r1"]);
    expect(fig(r, "Priya: flags that ended in churn or contraction").sources.ids).toEqual(["r2"]);
  });

  it("flags not yet at 90 days are counted apart, not as a bad outcome", () => {
    expect(fig(r, "Priya: flags not yet at 90 days").sources.ids).toEqual(["r3"]);
  });

  it("uses teamLoad for accounts and ARR: no ARR on file is said, not added as zero", () => {
    expect(fig(r, "Priya: accounts").value).toBe(2);
    expect(fig(r, "Priya: ARR owned")).toMatchObject({
      unit: "money",
      value: "10000",
      currency: "USD",
    });
    expect(fig(r, "Priya: accounts with no ARR on file").sources.ids).toEqual(["a2"]);
  });

  it("accounts nobody owns have their own row", () => {
    expect(fig(r, "No owner: accounts").value).toBe(1);
  });

  it("an owner with no flags has no outcome figure, not 0", () => {
    const e = teamActivityReport({ ...input, outcomes: [] });
    const f = fig(e, "Priya: flags that ended renewed or recovered");
    expect(f.value).toBeNull();
    expect(f.reason).toMatch(/No flags/);
  });

  it("every figure is proven", () => everyFigureIsProven(r));
});
