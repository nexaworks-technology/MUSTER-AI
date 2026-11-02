import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { getAccount, type Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import { listPeople, setChampion } from "../service";

let admin: Actor;
let accountId: string;
let otherWorkspaceAccountId: string;
let alice: string;
let bob: string;

beforeAll(async () => {
  const a = await createTestAdmin("People");
  admin = a.actor;
  const db = scopedDb(admin);
  const account = await db.account.create({
    data: { workspaceId: admin.workspaceId, name: "People Co", tier: "MID_TOUCH" },
  });
  accountId = account.id;
  alice = (
    await db.contact.create({ data: { workspaceId: admin.workspaceId, accountId, name: "Alice" } })
  ).id;
  bob = (
    await db.contact.create({ data: { workspaceId: admin.workspaceId, accountId, name: "Bob" } })
  ).id;
  await db.stakeholderRole.create({
    data: {
      workspaceId: admin.workspaceId,
      accountId,
      contactId: alice,
      role: "CHAMPION",
      validFrom: new Date(Date.now() - 86_400_000),
    },
  });
  const other = await createTestAdmin("PeopleOther");
  otherWorkspaceAccountId = (
    await scopedDb(other.actor).account.create({
      data: { workspaceId: other.actor.workspaceId, name: "Elsewhere", tier: "LONG_TAIL" },
    })
  ).id;
});

describe("stakeholder map", () => {
  it("moving the champion closes the old role and keeps its history", async () => {
    await setChampion(admin, { accountId, contactId: bob });
    const people = await listPeople(admin, accountId);
    const a = people.find((p) => p.id === alice)!;
    const b = people.find((p) => p.id === bob)!;
    expect(b.currentRoles).toEqual(["CHAMPION"]);
    expect(a.currentRoles).toEqual([]);
    expect(a.pastRoles.map((r) => r.role)).toEqual(["CHAMPION"]);
    expect(
      await scopedDb(admin).auditLog.count({
        where: { action: "contact.champion_set", targetId: accountId },
      }),
    ).toBe(1);
  });

  it("a Viewer cannot change the champion", async () => {
    await expect(
      setChampion({ ...admin, role: "VIEWER" }, { accountId, contactId: alice }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("an account from another workspace is not found (route renders 404)", async () => {
    expect(await getAccount(admin, otherWorkspaceAccountId)).toBeNull();
    await expect(listPeople(admin, otherWorkspaceAccountId)).rejects.toThrow(/not found/);
  });

  it("an account outside a CSM's book is not found for that CSM", async () => {
    expect(
      await getAccount(
        { ...admin, role: "CSM", bookScope: "OWN", membershipId: "someone-else" },
        accountId,
      ),
    ).toBeNull();
  });
});
