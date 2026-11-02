import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { accountListQuery, PAGE_SIZE } from "../schemas";
import { listAccounts, type Actor } from "../service";

let admin: Actor;
let csm: Actor;

beforeAll(async () => {
  const a = await createTestAdmin("List");
  admin = a.actor;
  const db = scopedDb(admin);
  // A second member acting as a CSM with their own book.
  const csmMembership = await db.membership.create({
    data: {
      workspaceId: admin.workspaceId,
      userId: (await db.user.create({ data: { email: `csm-${admin.workspaceId}@example.test` } }))
        .id,
      role: "CSM",
    },
  });
  csm = {
    ...admin,
    membershipId: csmMembership.id,
    role: "CSM",
    canViewRevenue: false,
    bookScope: "OWN",
  };
  const rows = Array.from({ length: 70 }, (_, i) => ({
    workspaceId: admin.workspaceId,
    name: `Acct ${String(i).padStart(2, "0")}`,
    tier: (i % 3 === 0 ? "HIGH_TOUCH" : i % 3 === 1 ? "MID_TOUCH" : "LONG_TAIL") as "HIGH_TOUCH",
    ownerMembershipId: i < 10 ? csmMembership.id : i < 20 ? null : admin.membershipId,
    arrMinor: i === 5 ? null : BigInt(i * 100_000),
    arrCurrency: "USD",
  }));
  await db.account.createMany({ data: rows });
});

const q = (input: Record<string, string> = {}) => accountListQuery.parse(input);

describe("Accounts list", () => {
  it("pages through every row exactly once, server-side", async () => {
    const first = await listAccounts(admin, q());
    expect(first.rows).toHaveLength(PAGE_SIZE);
    const second = await listAccounts(admin, q({ cursor: first.nextCursor! }));
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(70);
    expect(second.nextCursor).toBeNull();
  });

  it("searches, filters and sorts in the database", async () => {
    expect((await listAccounts(admin, q({ q: "acct 1" }))).rows.map((r) => r.name)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Acct 1${i}`),
    );
    expect(
      (await listAccounts(admin, q({ tier: "HIGH_TOUCH" }))).rows.every(
        (r) => r.tier === "HIGH_TOUCH",
      ),
    ).toBe(true);
    expect((await listAccounts(admin, q({ owner: "none" }))).total).toBe(10);
    const byArr = await listAccounts(admin, q({ sort: "arr", dir: "desc" }));
    expect(byArr.rows[0]!.name).toBe("Acct 69");
  });

  it("puts accounts with no ARR last instead of treating them as zero (Rule 4)", async () => {
    const asc = await listAccounts(admin, q({ sort: "arr", dir: "asc", cursor: "50" }));
    expect(asc.rows.at(-1)!.name).toBe("Acct 05");
  });

  it("a CSM sees only their own book by default", async () => {
    const page = await listAccounts(csm, q());
    expect(page.total).toBe(10);
    expect(page.rows.every((r) => r.ownerName !== null)).toBe(true);
  });

  it("TEAM scope adds the unowned pool to the CSM's own accounts (D-41)", async () => {
    expect((await listAccounts({ ...csm, bookScope: "TEAM" }, q())).total).toBe(20);
  });

  it("without revenue access, ARR is absent and ARR sorting is ignored", async () => {
    const page = await listAccounts(csm, q({ sort: "arr", dir: "desc" }));
    expect(page.arrVisible).toBe(false);
    expect(page.rows.every((r) => !("arr" in r))).toBe(true);
    expect(page.rows.map((r) => r.name)).toEqual([...page.rows.map((r) => r.name)].sort());
  });
});
