import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import {
  createPortalAccess,
  getPortalView,
  revokePortalAccess,
  verifyPortalAccess,
  PortalAuthError,
} from "../service";

describe("Slice 10: Customer Portal & Penetration Suite (Rule 2 & Decision 5)", () => {
  it("generates 256-bit token, stores SHA-256 hash at rest, and authenticates valid tokens", async () => {
    const { actor: admin } = await createTestAdmin("portal-auth");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Portal Test Account",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });

    const contact = await db.contact.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        email: "alice@portal.test",
        name: "Alice Executive",
      },
    });

    const { rawToken, access } = await createPortalAccess(admin, {
      accountId: account.id,
      contactId: contact.id,
    });

    expect(rawToken).toHaveLength(64); // 256 bits in hex
    expect(access.tokenHash).not.toBe(rawToken);
    expect(access.tokenHash).toHaveLength(64); // SHA-256 hex
    expect(access.expiresAt.getTime()).toBeGreaterThan(Date.now() + 13 * 86400 * 1000);

    // Verify token resolves strictly to (workspaceId, accountId, contactId)
    const session = await verifyPortalAccess(rawToken);
    expect(session.workspaceId).toBe(admin.workspaceId);
    expect(session.accountId).toBe(account.id);
    expect(session.contactId).toBe(contact.id);
  });

  it("expired token is refused with PortalAuthError", async () => {
    const { actor: admin } = await createTestAdmin("portal-expired");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Expired Token Account",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });

    const contact = await db.contact.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        email: "bob@portal.test",
        name: "Bob Expired",
      },
    });

    const { rawToken } = await createPortalAccess(admin, {
      accountId: account.id,
      contactId: contact.id,
      expiresInDays: -1, // Expired yesterday
    });

    await expect(verifyPortalAccess(rawToken)).rejects.toThrow(PortalAuthError);
    await expect(verifyPortalAccess(rawToken)).rejects.toThrow(/expired/i);
  });

  it("revoked token is refused with PortalAuthError and revocation is audited", async () => {
    const { actor: admin } = await createTestAdmin("portal-revoked");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Revoked Token Account",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });

    const contact = await db.contact.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        email: "carol@portal.test",
        name: "Carol Revoked",
      },
    });

    const { rawToken, access } = await createPortalAccess(admin, {
      accountId: account.id,
      contactId: contact.id,
    });

    // Revoke
    await revokePortalAccess(admin, access.id);

    await expect(verifyPortalAccess(rawToken)).rejects.toThrow(PortalAuthError);
    await expect(verifyPortalAccess(rawToken)).rejects.toThrow(/revoked/i);

    const audit = await db.auditLog.findMany({
      where: {
        workspaceId: admin.workspaceId,
        targetId: access.id,
        action: "portal.access_revoked",
      },
    });
    expect(audit.length).toBe(1);
  });

  it("attack test: token for Account A cannot see or access Account B's data (cross-account attack)", async () => {
    const { actor: admin } = await createTestAdmin("portal-attack");
    const db = scopedDb(admin);

    // Account A (Victim)
    const accountA = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Account A (Victim)",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });
    await db.contact.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: accountA.id,
        email: "alice@a.test",
        name: "Alice A",
      },
    });
    await db.successPlan.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: accountA.id,
        title: "Confidential Strategy Plan A",
        sharedWithPortal: true,
      },
    });

    // Account B (Attacker)
    const accountB = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Account B (Attacker)",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });
    const contactB = await db.contact.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: accountB.id,
        email: "mallory@b.test",
        name: "Mallory Attacker",
      },
    });

    const { rawToken: tokenB } = await createPortalAccess(admin, {
      accountId: accountB.id,
      contactId: contactB.id,
    });

    // When Attacker B requests portal view, they MUST see only Account B
    const portalData = await getPortalView(tokenB);
    expect(portalData.account.id).toBe(accountB.id);
    expect(portalData.account.name).toBe("Account B (Attacker)");
    expect(portalData.contact.id).toBe(contactB.id);

    // Attacker B cannot see Account A's plans
    const titles = portalData.successPlans.map((p) => p.title);
    expect(titles).not.toContain("Confidential Strategy Plan A");

    // Audit log records PORTAL_CONTACT
    const audit = await db.auditLog.findMany({
      where: {
        workspaceId: admin.workspaceId,
        actorType: "PORTAL_CONTACT",
        actorId: contactB.id,
        action: "portal.viewed",
      },
    });
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it("portal sees only success plans where sharedWithPortal is true", async () => {
    const { actor: admin } = await createTestAdmin("portal-unshared");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Filter Plan Account",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });
    const contact = await db.contact.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        email: "dave@portal.test",
        name: "Dave Customer",
      },
    });

    // Unshared plan
    await db.successPlan.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        title: "Internal Unshared Plan",
        sharedWithPortal: false,
      },
    });

    // Shared plan
    await db.successPlan.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        title: "Customer Facing Plan",
        sharedWithPortal: true,
      },
    });

    const { rawToken } = await createPortalAccess(admin, {
      accountId: account.id,
      contactId: contact.id,
    });

    const view = await getPortalView(rawToken);
    const planTitles = view.successPlans.map((p) => p.title);
    expect(planTitles).toContain("Customer Facing Plan");
    expect(planTitles).not.toContain("Internal Unshared Plan");
  });
});
