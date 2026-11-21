import { describe, expect, it } from "vitest";
import { askAi } from "../definitions/ask-ai";
import { evaluateOutput } from "../evaluate";
import { checkNumbers } from "../validate";
import type { ContextBundle } from "../schemas";

/**
 * DEMO-WALKTHROUGH FAIL 46: "What renewals are due in the next 30 days?" was refused because the
 * answer restated the asker's own "30 days". A numeral the asker wrote is not a claim about a record;
 * a numeral that states a record fact is still checked exactly as before.
 */
const bundle: ContextBundle = [
  {
    sourceType: "Renewal",
    sourceId: "r1",
    fields: { account: "Elmstead", renewalDate: "2026-12-09", seats: 40 },
  },
];
const base = { reasoningSummary: "Read the renewals.", confidence: 0.8, proposedActions: [] };
const cites = [{ sourceType: "Renewal", sourceId: "r1" }];
const asked = ["What renewals are due in the next 30 days?"];
const run = (answer: string, askerText = asked) =>
  evaluateOutput(askAi, bundle, { ...base, answer, citations: cites }, {}, askerText);

describe("numbers from the asker's own question", () => {
  it("restating the question's window is not an uncited claim", () => {
    const r = run("One renewal is due in the next 30 days: Elmstead on 2026-12-09.");
    expect(r.status).toBe("SUCCEEDED");
  });

  it("the same window in other words around it is still the asker's (unit word kept)", () => {
    expect(run("Within 30 days, Elmstead renews on 2026-12-09.").status).toBe("SUCCEEDED");
  });

  it("the window written as an adjective or in the singular is the same window", () => {
    expect(run("In the 30-day window, Elmstead renews on 2026-12-09.").status).toBe("SUCCEEDED");
    expect(run("Elmstead is the only renewal inside 30 day range: 2026-12-09.").status).toBe(
      "SUCCEEDED",
    );
    expect(run("Elmstead renews on 2026-12-09, 30-seat plan.").status).toBe("UNCITED");
  });

  it("the question's numeral used for a different thing is a record claim and is checked", () => {
    const r = run("Elmstead renews on 2026-12-09 with 30 seats.");
    expect(r.status).toBe("UNCITED");
    expect(r.status === "UNCITED" && r.problems).toEqual([
      'the number "30" is not in any record it cites',
    ]);
  });

  it("the window may be restated more than once (live answers do: heading and summary)", () => {
    const r = run(
      "Due in the next 30 days: Elmstead. Upcoming (next 30 days): Elmstead on 2026-12-09.",
    );
    expect(r.status).toBe("SUCCEEDED");
  });

  it("record facts in the same answer are checked exactly as before", () => {
    expect(run("In the next 30 days: Elmstead on 2026-12-09, 40 seats.").status).toBe("SUCCEEDED");
    expect(run("In the next 30 days: Elmstead on 2026-12-19, 40 seats.").status).toBe("UNCITED");
    expect(run("In the next 30 days: Elmstead with 45 seats.").status).toBe("UNCITED");
  });

  it("without the asker's text nothing is exempt (every other agent, and golden replays)", () => {
    expect(run("Due in the next 30 days: Elmstead.", []).status).toBe("UNCITED");
    expect(checkNumbers(["Due in the next 30 days."], bundle)).toEqual([
      'the number "30" is not in any record it cites',
    ]);
  });

  it("the asker's earlier turns count, so a follow-up may restate their window", () => {
    const r = run("Elmstead is the only one in the next 30 days.", [
      "And the soonest one?",
      "What renews in the next 30 days?",
    ]);
    expect(r.status).toBe("SUCCEEDED");
  });

  it("the Ask AI context hands the question and the asker's earlier turns to the check", async () => {
    const built = await askAi.buildContext(
      // With no retrieval steps, buildContext only reads the asker's membership.
      stubDb(),
      {
        question: "What renews in the next 30 days?",
        membershipId: "m1",
        threadId: "t1",
        messageId: "u1",
        history: [
          { role: "USER", text: "Any renewals in 60 days?" },
          { role: "ASSISTANT", text: "Two: 14 and 21 days out." },
        ],
        retrieval: [],
      },
      { workspaceId: "w1" },
    );
    expect(built.askerText).toEqual([
      "Any renewals in 60 days?",
      "What renews in the next 30 days?",
    ]);
  });
});

function stubDb(): Parameters<typeof askAi.buildContext>[0] {
  const membership = {
    id: "m1",
    role: "ADMIN",
    bookScope: "ALL",
    canViewRevenue: true,
    status: "ACTIVE",
    userId: "u",
    user: { name: "A", email: "a@x.test" },
  };
  return {
    membership: { findUniqueOrThrow: async () => membership },
  } as unknown as Parameters<typeof askAi.buildContext>[0];
}
