import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { recomputeCommercials, setRenewalDate } from "@/modules/billing/service";
import { createTestAdmin } from "@/test/fixtures";
import { updateAccountFields, type Actor } from "../service";

let admin: Actor;
let csm: Actor;
let csmAccount: string;
let adminAccount: string;
let noContract: string;

beforeAll(async () => {
  admin = (await createTestAdmin("Edit")).actor;
  const db = scopedDb(admin);
  const ws = admin.workspaceId;
  const user = await db.user.create({
    data: { email: `edit-csm-${ws}@example.test`, name: "Edit CSM" },
  });
  const m = await db.membership.create({ data: { workspaceId: ws, userId: user.id, role: "CSM" } });
  csm = {
    ...admin,
    userId: user.id,
    membershipId: m.id,
    role: "CSM",
    canViewRevenue: false,
    bookScope: "OWN",
  };
  csmAccount = (
    await db.account.create({
      data: { workspaceId: ws, name: "CSM's", tier: "MID_TOUCH", ownerMembershipId: m.id },
    })
  ).id;
  adminAccount = (
    await db.account.create({
      data: {
        workspaceId: ws,
        name: "Admin's",
        tier: "LONG_TAIL",
        ownerMembershipId: admin.membershipId,
      },
    })
  ).id;
  noContract = (
    await db.account.create({ data: { workspaceId: ws, name: "No contract", tier: "MID_TOUCH" } })
  ).id;
  await db.contract.create({
    data: {
      workspaceId: ws,
      accountId: adminAccount,
      startDate: new Date("2026-01-01"),
      valueMinor: 6_000_000n,
      renewalDate: new Date("2027-01-01"),
    },
  });
  await db.$tenantTransaction((tx) => recomputeCommercials(tx, ws, adminAccount));
});

describe("inline edit", () => {
  it("re-derives the tier from ARR when the contract changes (rule tier)", async () => {
    const account = await scopedDb(admin).account.findUniqueOrThrow({
      where: { id: adminAccount },
    });
    expect(account).toMatchObject({ tier: "HIGH_TOUCH", tierSource: "RULE" });
  });

  it("an admin changes the owner; the audit row has before and after", async () => {
    await updateAccountFields(admin, adminAccount, { ownerMembershipId: csm.membershipId });
    const audit = await scopedDb(admin).auditLog.findFirst({
      where: { action: "account.updated", targetId: adminAccount },
    });
    expect(audit?.before).toMatchObject({ ownerMembershipId: admin.membershipId });
    expect(audit?.after).toMatchObject({ ownerMembershipId: csm.membershipId });
  });

  it("a CSM edits the stage of their own account but cannot reassign it", async () => {
    expect(
      (await updateAccountFields(csm, csmAccount, { lifecycleStage: "RENEWING" })).lifecycleStage,
    ).toBe("RENEWING");
    await expect(
      updateAccountFields(csm, csmAccount, { ownerMembershipId: admin.membershipId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a CSM cannot edit an account outside their book; a Viewer cannot edit at all", async () => {
    await expect(
      updateAccountFields(csm, noContract, { lifecycleStage: "MATURE" }),
    ).rejects.toThrow(/not found/i);
    await expect(
      updateAccountFields({ ...admin, role: "VIEWER" }, noContract, { lifecycleStage: "MATURE" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a manual tier survives contract changes; handing it back to the rule re-derives it", async () => {
    await updateAccountFields(admin, adminAccount, { tier: "LONG_TAIL" });
    await scopedDb(admin).$tenantTransaction((tx) =>
      recomputeCommercials(tx, admin.workspaceId, adminAccount),
    );
    expect(
      (await scopedDb(admin).account.findUniqueOrThrow({ where: { id: adminAccount } })).tier,
    ).toBe("LONG_TAIL");
    expect((await updateAccountFields(admin, adminAccount, { tier: "RULE" })).tier).toBe(
      "HIGH_TOUCH",
    );
  });

  it("sets a renewal date only where a contract exists", async () => {
    await setRenewalDate(admin, adminAccount, new Date("2027-03-01"));
    expect(
      (await scopedDb(admin).account.findUniqueOrThrow({ where: { id: adminAccount } })).renewalDate
        ?.toISOString()
        .slice(0, 10),
    ).toBe("2027-03-01");
    await expect(setRenewalDate(admin, noContract, new Date("2027-03-01"))).rejects.toThrow(
      /no contract on file/,
    );
  });

  it("rejects an empty edit in plain words", async () => {
    await expect(updateAccountFields(admin, adminAccount, {})).rejects.toThrow(/Nothing to change/);
  });
});
