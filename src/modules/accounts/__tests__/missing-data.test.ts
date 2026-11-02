import { describe, expect, it } from "vitest";
import { nextMissingQuestion, type MissingDataFacts, type PromptState } from "../missing-data";

const NOW = new Date("2026-11-02T14:00:00Z");
const DAY = 86_400_000;
const settings = { snoozeDays: 7, maxPromptsPerUserPerDay: 3 };
const owner = { membershipId: "m-owner", role: "CSM" as const };
const admin = { membershipId: "m-admin", role: "ADMIN" as const };
const leader = { membershipId: "m-lead", role: "CS_LEADER" as const };
const facts = (o: Partial<MissingDataFacts> = {}): MissingDataFacts => ({
  accountId: "a1",
  tier: "MID_TOUCH",
  ownerMembershipId: "m-owner",
  hasCurrentContract: true,
  renewalDateMissing: true,
  hasContacts: true,
  hasKeyContact: true,
  ...o,
});
const ask = (
  f: MissingDataFacts,
  viewer: typeof owner | typeof admin | typeof leader,
  prompts: PromptState[] = [],
  askedToday = 0,
) =>
  nextMissingQuestion({
    facts: f,
    viewer,
    prompts,
    askedTodayByViewer: askedToday,
    settings,
    now: NOW,
  });

describe("missing-data helper", () => {
  it("asks the owner one question at a time, in priority order", () => {
    expect(ask(facts({ renewalDateMissing: true, hasKeyContact: false }), owner)?.field).toBe(
      "RENEWAL_DATE",
    );
    expect(ask(facts({ renewalDateMissing: false, hasKeyContact: false }), owner)?.field).toBe(
      "KEY_CONTACT",
    );
    expect(ask(facts({ renewalDateMissing: false }), owner)).toBeNull();
  });

  it("asks only the owner, or an Admin / CS Leader when there is no owner", () => {
    expect(ask(facts(), admin)).toBeNull();
    const unowned = facts({ ownerMembershipId: null });
    expect(ask(unowned, admin)?.field).toBe("OWNER");
    expect(ask(unowned, leader)?.field).toBe("OWNER");
    expect(ask(unowned, { membershipId: "m-other", role: "CSM" })).toBeNull();
  });

  it("never asks about the owner of an unowned long-tail account (the Digital CSM pool)", () => {
    expect(ask(facts({ ownerMembershipId: null, tier: "LONG_TAIL" }), admin)?.field).toBe(
      "RENEWAL_DATE",
    );
    expect(
      ask(facts({ ownerMembershipId: null, tier: "LONG_TAIL", renewalDateMissing: false }), admin),
    ).toBeNull();
  });

  it("Skip snoozes that question for the workspace's snooze period (7 days by default)", () => {
    const skipped: PromptState = {
      field: "RENEWAL_DATE",
      answeredAt: null,
      snoozeUntil: new Date(NOW.getTime() + 7 * DAY),
    };
    expect(ask(facts({ hasKeyContact: false }), owner, [skipped])?.field).toBe("KEY_CONTACT");
    expect(ask(facts(), owner, [skipped])).toBeNull();
    const expired = { ...skipped, snoozeUntil: new Date(NOW.getTime() - 1) };
    expect(ask(facts(), owner, [expired])?.field).toBe("RENEWAL_DATE");
  });

  it("an answered question is never asked again", () => {
    expect(
      ask(facts(), owner, [{ field: "RENEWAL_DATE", answeredAt: NOW, snoozeUntil: null }]),
    ).toBeNull();
  });

  it("never nags: no new questions after the daily limit, but an open one keeps showing", () => {
    expect(ask(facts(), owner, [], 3)).toBeNull();
    const alreadyAsked: PromptState = {
      field: "RENEWAL_DATE",
      answeredAt: null,
      snoozeUntil: null,
      askedToday: true,
    };
    expect(ask(facts(), owner, [alreadyAsked], 3)?.field).toBe("RENEWAL_DATE");
  });

  it("does not ask about a renewal date when there is no contract (that is shown as 'No contract on file')", () => {
    expect(ask(facts({ hasCurrentContract: false, renewalDateMissing: true }), owner)).toBeNull();
  });

  it("does not ask for a key contact when the account has no contacts at all", () => {
    expect(
      ask(facts({ renewalDateMissing: false, hasContacts: false, hasKeyContact: false }), owner),
    ).toBeNull();
  });

  it("phrases each question plainly", () => {
    expect(ask(facts(), owner)?.question).toBe("When does this contract renew?");
    expect(ask(facts({ ownerMembershipId: null }), admin)?.question).toBe("Who owns this account?");
    expect(ask(facts({ renewalDateMissing: false, hasKeyContact: false }), owner)?.question).toBe(
      "Who is the champion at this account?",
    );
  });
});
