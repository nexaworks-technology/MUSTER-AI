import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { setRenewalDate } from "@/modules/billing/service";
import { createTestAdmin } from "@/test/fixtures";
import {
  getMissingDataQuestion,
  markMissingDataAnswered,
  skipMissingData,
  type Actor,
} from "../service";

const NOW = new Date("2026-11-02T14:00:00Z");
let admin: Actor;
let owner: Actor;
let kestrelLike: string;
let unowned: string;

beforeAll(async () => {
  admin = (await createTestAdmin("Missing")).actor;
  const db = scopedDb(admin);
  const ws = admin.workspaceId;
  const user = await db.user.create({ data: { email: `owner-${ws}@example.test`, name: "Owner" } });
  const m = await db.membership.create({ data: { workspaceId: ws, userId: user.id, role: "CSM" } });
  owner = {
    ...admin,
    userId: user.id,
    membershipId: m.id,
    role: "CSM",
    canViewRevenue: false,
    bookScope: "OWN",
  };
  kestrelLike = (
    await db.account.create({
      data: {
        workspaceId: ws,
        name: "No renewal date",
        tier: "MID_TOUCH",
        ownerMembershipId: m.id,
      },
    })
  ).id;
  await db.contract.create({
    data: { workspaceId: ws, accountId: kestrelLike, startDate: new Date("2026-04-01") },
  });
  unowned = (
    await db.account.create({ data: { workspaceId: ws, name: "Nobody's", tier: "MID_TOUCH" } })
  ).id;
});

describe("missing-data helper (integration)", () => {
  it("asks the owner, not the admin, about the renewal date; answering clears it for good", async () => {
    expect(await getMissingDataQuestion(admin, kestrelLike, NOW)).toBeNull();
    expect(await getMissingDataQuestion(owner, kestrelLike, NOW)).toMatchObject({
      field: "RENEWAL_DATE",
      question: "When does this contract renew?",
      snoozeDays: 7,
    });
    await setRenewalDate(owner, kestrelLike, new Date("2027-04-01"));
    await markMissingDataAnswered(owner, kestrelLike, "RENEWAL_DATE", NOW);
    expect(await getMissingDataQuestion(owner, kestrelLike, NOW)).toBeNull();
  });

  it("asks an admin who owns an unowned account; Skip hides it for 7 days, then it may return", async () => {
    expect((await getMissingDataQuestion(admin, unowned, NOW))?.field).toBe("OWNER");
    await skipMissingData(admin, unowned, "OWNER", NOW);
    expect(
      await getMissingDataQuestion(admin, unowned, new Date(NOW.getTime() + 6 * 86_400_000)),
    ).toBeNull();
    expect(
      (await getMissingDataQuestion(admin, unowned, new Date(NOW.getTime() + 8 * 86_400_000)))
        ?.field,
    ).toBe("OWNER");
  });

  it("a Viewer is never asked (no edit rights)", async () => {
    expect(await getMissingDataQuestion({ ...admin, role: "VIEWER" }, unowned, NOW)).toBeNull();
  });
});
