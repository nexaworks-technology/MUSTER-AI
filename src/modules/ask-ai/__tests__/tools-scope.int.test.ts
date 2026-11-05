import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { ASK_TOOLS, runAskTool, type AskActor, type ToolOutput } from "../service";

/**
 * M11 S8 (test-first): Ask AI's tools run AS THE ASKING USER — workspace scope AND that user's
 * permissions and book scope (M11 rule 1). Enumerated over the whole tool registry:
 * - a CSM with an OWN book gets notFound (no records) for another CSM's account through every tool;
 * - ids from workspace B return notFound through every tool;
 * - a user without revenue:view gets no revenue figure through any tool (Ask AI is not a bypass);
 * - getContract on an account with no contract says so (notFound), never invents one.
 */
type Fixture = Awaited<ReturnType<typeof setup>>;

async function member(ws: string, role: "CSM" | "CS_LEADER", canViewRevenue: boolean) {
  const user = await rawDb.user.create({
    data: { email: `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`, name: role },
  });
  const m = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, true)`;
    return tx.membership.create({
      data: {
        workspaceId: ws,
        userId: user.id,
        role,
        bookScope: role === "CSM" ? "OWN" : "ALL",
        canViewRevenue,
      },
    });
  });
  const actor: AskActor = {
    workspaceId: ws,
    userId: user.id,
    membershipId: m.id,
    role: m.role,
    canViewRevenue: m.canViewRevenue,
    bookScope: m.bookScope,
  };
  return actor;
}

async function setup(label: string) {
  const { actor: admin } = await createTestAdmin(label);
  const ws = admin.workspaceId;
  const db = scopedDb(admin);
  const leo = await member(ws, "CSM", false);
  const aisha = await member(ws, "CSM", false);
  const leader = await member(ws, "CS_LEADER", false);
  const account = async (owner: string, name: string) =>
    db.account.create({
      data: {
        workspaceId: ws,
        name,
        tier: "MID_TOUCH",
        ownerMembershipId: owner,
        arrMinor: 12_345_600n,
        arrCurrency: "USD",
      },
    });
  const mine = await account(leo.membershipId, `Mine ${label}`);
  const theirs = await account(aisha.membershipId, `Theirs ${label}`);
  const noContract = await account(leo.membershipId, `NoContract ${label}`);
  for (const a of [mine, theirs])
    await db.contract.create({
      data: {
        workspaceId: ws,
        accountId: a.id,
        startDate: new Date("2026-01-01"),
        renewalDate: new Date("2027-01-01"),
        valueMinor: 12_345_600n,
        currency: "USD",
      },
    });
  return { admin, ws, leo, aisha, leader, mine, theirs, noContract };
}

/** Every tool, called against `accountId`, with the minimal input that names that account. */
function inputFor(tool: string, accountId: string): Record<string, unknown> {
  switch (tool) {
    case "searchAccounts":
      return { query: "" };
    case "listRenewals":
      return { days: 365 };
    case "readDocument":
      return { documentId: accountId };
    default:
      return { accountId };
  }
}

const recordText = (out: ToolOutput) => JSON.stringify(out.records);

let A: Fixture;
let B: Fixture;
beforeAll(async () => {
  A = await setup("AskA");
  B = await setup("AskB");
});

describe("Ask AI tools run as the asking user", () => {
  it("the registry holds the read tools and no write, SQL or cross-workspace tool", () => {
    const names = ASK_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "getAccount360Summary",
        "getContract",
        "getHealthWithReasons",
        "listPromises",
        "listRenewals",
        "listSignals",
        "listTickets",
        "readDocument",
        "searchAccounts",
        "searchConversations",
      ].sort(),
    );
    expect(names.some((n) => /sql|raw|write|update|delete|workspace/i.test(n))).toBe(false);
  });

  for (const tool of ASK_TOOLS.map((t) => t.name)) {
    it(`${tool}: a CSM with an OWN book cannot see another CSM's account`, async () => {
      const out = await runAskTool(A.leo, tool, inputFor(tool, A.theirs.id));
      expect(recordText(out)).not.toContain(A.theirs.id);
      expect(recordText(out)).not.toContain(A.theirs.name);
    });

    it(`${tool}: ids from another workspace return nothing`, async () => {
      const out = await runAskTool(A.admin, tool, inputFor(tool, B.mine.id));
      expect(recordText(out)).not.toContain(B.mine.id);
      expect(recordText(out)).not.toContain(B.mine.name);
    });

    it(`${tool}: no revenue figure without revenue:view`, async () => {
      const out = await runAskTool(A.leader, tool, inputFor(tool, A.mine.id));
      const text = recordText(out);
      expect(text).not.toMatch(/123,?456/); // the seeded ARR / contract value in any format
      expect(text).not.toMatch(/"(arr|value|amount|price)[A-Za-z]*"\s*:/i);
    });
  }

  it("an account outside the book is reported as not found, without saying whose it is", async () => {
    const out = await runAskTool(A.leo, "getAccount360Summary", { accountId: A.theirs.id });
    expect(out.records).toEqual([]);
    expect(out.notFound).toMatch(/cannot see/i);
  });

  it("getContract: with revenue:view the value is a cited field; with no contract it says so", async () => {
    const withMoney = await runAskTool(A.admin, "getContract", { accountId: A.mine.id });
    expect(recordText(withMoney)).toContain("123456");
    expect(withMoney.records[0]!.ref).toMatch(/^Contract:/);
    const none = await runAskTool(A.admin, "getContract", { accountId: A.noContract.id });
    expect(none.records).toEqual([]);
    expect(none.notFound).toMatch(/cannot see a contract/i);
  });

  it("a leader with an ALL book sees every account in the workspace through searchAccounts", async () => {
    const out = await runAskTool(A.leader, "searchAccounts", { query: "" });
    const text = recordText(out);
    expect(text).toContain(A.mine.id);
    expect(text).toContain(A.theirs.id);
    expect(text).not.toContain(B.mine.id);
  });

  it("refuses an unknown tool and invalid input", async () => {
    await expect(runAskTool(A.admin, "runSql", {})).rejects.toThrow(/unknown tool/i);
    await expect(runAskTool(A.admin, "getContract", { accountId: 42 })).rejects.toThrow();
  });
});
