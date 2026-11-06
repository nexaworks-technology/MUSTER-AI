import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { listPeople, loadChampionGuard } from "../service";

/** M12 B3: Account 360 People tab: statements do not grow when 4 more contacts are added. */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("People tab does not grow with rows", () => {
  it("listPeople and loadChampionGuard: same statements before and after adding 4 contacts", async () => {
    const accountId = w.bigAccounts[0]!;
    const before = {
      people: await countQueries(() => listPeople(w.big, accountId)),
      guard: await countQueries(() => loadChampionGuard(w.big, accountId)),
    };
    await w.db.contact.createMany({
      data: Array.from({ length: 4 }, (_, i) => ({
        workspaceId: w.ctx.workspaceId,
        accountId,
        name: `Extra Contact ${i}`,
        email: `extra${i}@budget.example.test`,
        title: "Analyst",
        status: "ACTIVE" as const,
      })),
    });
    const after = {
      people: await countQueries(() => listPeople(w.big, accountId)),
      guard: await countQueries(() => loadChampionGuard(w.big, accountId)),
    };
    expect(after.people.result.length).toBe(before.people.result.length + 4);
    expectBounded(after.people.queries, before.people.queries);
    expectBounded(after.guard.queries, before.guard.queries);
    expect(after.people.queries).toBeLessThanOrEqual(6);
    expect(after.guard.queries).toBeLessThanOrEqual(36);
  });
});
