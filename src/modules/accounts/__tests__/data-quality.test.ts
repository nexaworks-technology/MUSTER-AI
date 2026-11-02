import { describe, expect, it } from "vitest";
import {
  detectIssues,
  normalizeCompanyName,
  type DqAccount,
  type DqContact,
} from "../data-quality";

const NOW = new Date("2026-11-02T14:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const account = (
  id: string,
  name: string,
  domain: string | null,
  o: Partial<DqAccount> = {},
): DqAccount => ({
  id,
  name,
  domain,
  lifecycleStage: "ADOPTING",
  createdAt: daysAgo(300),
  updatedAt: daysAgo(2),
  lastTouchAt: daysAgo(2),
  ...o,
});
const contact = (
  id: string,
  accountId: string,
  name: string,
  email: string | null,
  createdDaysAgo = 100,
): DqContact => ({ id, accountId, name, email, createdAt: daysAgo(createdDaysAgo) });

describe("data-quality detector", () => {
  it("normalises company names (case, punctuation, legal suffixes)", () => {
    expect(normalizeCompanyName("Silverline Couriers Inc.")).toBe(
      normalizeCompanyName("silverline  couriers"),
    );
    expect(normalizeCompanyName("Acme Ltd")).toBe("acme");
  });

  it("flags duplicate accounts by domain or normalised name, with no automatic fix", () => {
    const issues = detectIssues({
      accounts: [
        account("a1", "Silverline Couriers", "silverline-couriers.test"),
        account("a2", "Silverline Couriers Inc.", "www.Silverline-Couriers.test"),
      ],
      contacts: [],
      now: NOW,
      staleAfterDays: 180,
    });
    expect(issues).toEqual([
      expect.objectContaining({
        kind: "DUPLICATE_ACCOUNT",
        accountId: "a1",
        fix: { type: "NONE" },
        detail: expect.stringContaining("Silverline Couriers Inc."),
      }),
    ]);
  });

  it("merges duplicate contacts on the same account (case/space-insensitive email, or same name), keeping the oldest", () => {
    const issues = detectIssues({
      accounts: [account("a1", "Silverline Couriers", "silverline-couriers.test")],
      contacts: [
        contact("c1", "a1", "Ken Ward", "ken.ward@silverline-couriers.test", 260),
        contact("c2", "a1", "Ken Ward", "KEN.WARD@silverline-couriers.test", 100),
        contact("c3", "a1", "Amy Stone", "amy.stone@silverline-couriers.test", 260),
        contact("c4", "a1", "Amy  Stone", "amy.stone@silverline-couriers.test ", 90),
      ],
      now: NOW,
      staleAfterDays: 180,
    });
    const merges = issues.filter((i) => i.kind === "DUPLICATE_CONTACT");
    // Order follows the stable issue key; what matters is which record is kept and removed.
    expect(merges.map((i) => i.fix)).toEqual(
      expect.arrayContaining([
        { type: "MERGE_CONTACTS", keepId: "c1", removeIds: ["c2"] },
        { type: "MERGE_CONTACTS", keepId: "c3", removeIds: ["c4"] },
      ]),
    );
    expect(merges).toHaveLength(2);
  });

  it("does not auto-merge the same person on two different accounts", () => {
    const issues = detectIssues({
      accounts: [account("a1", "One", "one.test"), account("a2", "Two", "two.test")],
      contacts: [
        contact("c1", "a1", "Ken", "ken@x.test"),
        contact("c2", "a2", "Ken", "ken@x.test"),
      ],
      now: NOW,
      staleAfterDays: 180,
    });
    expect(issues.filter((i) => i.kind === "DUPLICATE_CONTACT").map((i) => i.fix)).toEqual([
      { type: "NONE" },
    ]);
  });

  it("still merges on one account when the same person also sits on a duplicate account", () => {
    const issues = detectIssues({
      accounts: [
        account("a1", "Silverline Couriers", "silverline-couriers.test"),
        account("a2", "Silverline Couriers Inc.", "silverline-couriers.test"),
      ],
      contacts: [
        contact("c1", "a1", "Ken Ward", "ken.ward@silverline-couriers.test", 260),
        contact("c2", "a1", "Ken Ward", "KEN.WARD@silverline-couriers.test", 100),
        contact("c3", "a2", "Ken Ward", "ken.ward@silverline-couriers.test", 120),
      ],
      now: NOW,
      staleAfterDays: 180,
    });
    const contacts = issues.filter((i) => i.kind === "DUPLICATE_CONTACT").map((i) => i.fix);
    expect(contacts).toEqual(
      expect.arrayContaining([
        { type: "MERGE_CONTACTS", keepId: "c1", removeIds: ["c2"] },
        { type: "NONE" },
      ]),
    );
    expect(contacts).toHaveLength(2);
  });

  it("offers a safe normalisation for messy emails and flags invalid ones without changing them", () => {
    const issues = detectIssues({
      accounts: [account("a1", "One", "one.test")],
      contacts: [
        contact("c1", "a1", "Pat", " Pat@One.TEST "),
        contact("c2", "a1", "Lee", "not-an-email"),
      ],
      now: NOW,
      staleAfterDays: 180,
    });
    expect(issues.find((i) => i.contactId === "c1")).toMatchObject({
      kind: "INVALID_EMAIL",
      fix: { type: "NORMALIZE_EMAIL", contactId: "c1", email: "pat@one.test" },
    });
    expect(issues.find((i) => i.contactId === "c2")).toMatchObject({
      kind: "INVALID_EMAIL",
      fix: { type: "NONE" },
    });
  });

  it("flags accounts with no updates and no contact for longer than the threshold (not lost ones)", () => {
    const issues = detectIssues({
      accounts: [
        account("a1", "Quiet", "quiet.test", {
          updatedAt: daysAgo(200),
          lastTouchAt: daysAgo(190),
        }),
        account("a2", "Gone", "gone.test", {
          updatedAt: daysAgo(400),
          lastTouchAt: null,
          lifecycleStage: "LOST",
        }),
        account("a3", "Fresh", "fresh.test"),
      ],
      contacts: [],
      now: NOW,
      staleAfterDays: 180,
    });
    expect(issues.map((i) => [i.kind, i.accountId])).toEqual([["STALE", "a1"]]);
  });

  it("gives every issue a stable key so a re-scan does not duplicate it", () => {
    const input = {
      accounts: [account("a1", "Dup", "dup.test"), account("a2", "Dup", "dup.test")],
      contacts: [],
      now: NOW,
      staleAfterDays: 180,
    };
    expect(detectIssues(input).map((i) => i.dedupeKey)).toEqual(
      detectIssues(input).map((i) => i.dedupeKey),
    );
  });
});
