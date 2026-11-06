import { beforeAll, describe, expect, it } from "vitest";
import { budgetWorld, expectBounded } from "@/test/budget-world";
import { countQueries } from "@/test/budget-world";
import { listNotes } from "../service";

/** M12 B3: Account 360 Notes tab: statements do not grow when 4 more notes are added. */
let w: Awaited<ReturnType<typeof budgetWorld>>;
beforeAll(async () => {
  w = await budgetWorld();
}, 120_000);

describe("Notes tab does not grow with rows", () => {
  it("same statements before and after adding 4 notes", async () => {
    const accountId = w.bigAccounts[0]!;
    const note = (i: number) => ({
      workspaceId: w.ctx.workspaceId,
      accountId,
      authorMembershipId: w.big.membershipId,
      body: `Synthetic note ${i}`,
      tags: [],
      mentionMembershipIds: [],
    });
    // One note first: a relation read (author) only runs when there are rows to attach it to.
    await w.db.note.create({ data: note(0) });
    const before = await countQueries(() => listNotes(w.big, accountId));
    await w.db.note.createMany({ data: [1, 2, 3, 4].map(note) });
    const after = await countQueries(() => listNotes(w.big, accountId));
    expect(after.result.length).toBe(before.result.length + 4);
    expectBounded(after.queries, before.queries);
    expect(after.queries).toBeLessThanOrEqual(6);
  });
});
