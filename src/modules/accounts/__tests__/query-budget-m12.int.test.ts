import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded, twoVsFive } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { getAccount, getMissingDataQuestion, listOwners } from "../service";

/** M12 B3: the Account 360 shell (header, owner picker, missing-data question) stays fixed. */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Account 360 shell does not grow with rows", () => {
  it("same statements for any account, before and after adding 4 contacts", async () => {
    const accountId = w.bigAccounts[0]!;
    const load = async () => ({
      account: await countQueries(() => getAccount(w.big, accountId)),
      owners: await countQueries(() => listOwners(w.big)),
      missing: await countQueries(() => getMissingDataQuestion(w.big, accountId)),
    });
    const before = await load();
    await w.db.contact.createMany({
      data: [1, 2, 3, 4].map((i) => ({
        workspaceId: w.ctx.workspaceId,
        accountId,
        name: `Shell Contact ${i}`,
        email: `shell${i}@budget.example.test`,
        status: "ACTIVE" as const,
      })),
    });
    const after = await load();
    expectBounded(after.account.queries, before.account.queries);
    expectBounded(after.owners.queries, before.owners.queries);
    expectBounded(after.missing.queries, before.missing.queries);
    expect(after.account.queries).toBeLessThanOrEqual(4);
    expect(after.owners.queries).toBeLessThanOrEqual(4);
    expect(after.missing.queries).toBeLessThanOrEqual(10);
    const { two, five } = await twoVsFive(w, countQueries, (actor, ids) =>
      getAccount(actor, ids[0]!),
    );
    expectBounded(five.queries, two.queries);
  });
});
