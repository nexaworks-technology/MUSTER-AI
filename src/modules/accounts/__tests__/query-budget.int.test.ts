import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { countQueries } from "@/test/query-counter";
import { accountListQuery } from "../schemas";
import { listAccounts, type Actor } from "../service";

/**
 * No N+1 on the Accounts list (ARCHITECTURE §11): the number of SQL statements is fixed and does
 * not grow with the number of rows on the page. Budgets are deliberately tight.
 */
/** count + accounts + owners' memberships + owners' users — batched, never per row. */
const LIST_BUDGET = 4;
let actor: Actor;

beforeAll(async () => {
  const admin = await createTestAdmin("Budget");
  actor = admin.actor;
  const db = scopedDb(actor);
  await db.account.createMany({
    data: Array.from({ length: 60 }, (_, i) => ({
      workspaceId: actor.workspaceId,
      name: `Budget Account ${String(i).padStart(2, "0")}`,
      tier: "MID_TOUCH" as const,
      ownerMembershipId: actor.membershipId,
      arrMinor: BigInt(1_000_000 + i),
      arrCurrency: "USD",
    })),
  });
});

describe("Accounts list query budget", () => {
  it(`loads a page of 50 in at most ${LIST_BUDGET} queries`, async () => {
    const { result, queries } = await countQueries(() =>
      listAccounts(actor, accountListQuery.parse({})),
    );
    expect(result.rows).toHaveLength(50);
    expect(queries).toBeLessThanOrEqual(LIST_BUDGET);
  });

  it("uses the same number of queries for 5 rows as for 50 (no per-row queries)", async () => {
    const big = await countQueries(() => listAccounts(actor, accountListQuery.parse({})));
    const small = await countQueries(() =>
      listAccounts(actor, accountListQuery.parse({ q: "Account 0" })),
    );
    expect(small.result.rows.length).toBeLessThan(15);
    expect(small.queries).toBe(big.queries);
  });
});
