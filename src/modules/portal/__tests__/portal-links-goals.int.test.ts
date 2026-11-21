import { describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin, createTestUser } from "@/test/fixtures";
import {
  getPortalView,
  issuePortalLink,
  listPortalLinks,
  revokePortalLink,
  PortalAuthError,
} from "../service";

/**
 * DEMO-WALKTHROUGH FAIL 37: nothing in the app could give a customer portal access. FAIL 39: the
 * portal never showed a shared plan's goals. A person who may edit the account issues a link for
 * one of its contacts (shown once, stored only as a hash), sees the active links and revokes them;
 * the portal shows each shared plan's goals with their status.
 */
async function world(label: string) {
  const { workspace, actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const account = await db.account.create({
    data: { workspaceId: workspace.id, name: `${label} & Vale`, tier: "HIGH_TOUCH" },
  });
  const other = await db.account.create({
    data: { workspaceId: workspace.id, name: `${label} Other`, tier: "MID_TOUCH" },
  });
  const contact = await db.contact.create({
    data: {
      workspaceId: workspace.id,
      accountId: account.id,
      name: "Imogen Vale",
      email: "imogen@ov.test",
    },
  });
  const outsider = await db.contact.create({
    data: { workspaceId: workspace.id, accountId: other.id, name: "Out", email: "o@other.test" },
  });
  const noEmail = await db.contact.create({
    data: { workspaceId: workspace.id, accountId: account.id, name: "No Email" },
  });
  const user = await createTestUser(`${label}-csm`);
  const m = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
    return tx.membership.create({
      data: { workspaceId: workspace.id, userId: user.id, role: "CSM", bookScope: "OWN" },
    });
  });
  const csm = {
    workspaceId: workspace.id,
    userId: user.id,
    membershipId: m.id,
    role: "CSM" as const,
    canViewRevenue: false,
    bookScope: "OWN" as const,
  };
  return { actor, db, account, contact, outsider, noEmail, csm };
}

describe("issuing portal links from the app", () => {
  it("returns a working link once, lists it without the token, and revokes it", async () => {
    const w = await world("PortalIssue");
    const issued = await issuePortalLink(w.actor, {
      accountId: w.account.id,
      contactId: w.contact.id,
    });
    expect(issued.url).toMatch(/\/portal\/[0-9a-f]{64}$/);
    const token = issued.url.split("/portal/")[1]!;
    expect((await getPortalView(token)).contact.id).toBe(w.contact.id);

    const links = await listPortalLinks(w.actor, w.account.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ contactName: "Imogen Vale", active: true });
    expect(JSON.stringify(links)).not.toContain(token);

    await revokePortalLink(w.actor, { accountId: w.account.id, portalAccessId: links[0]!.id });
    await expect(getPortalView(token)).rejects.toBeInstanceOf(PortalAuthError);
    expect((await listPortalLinks(w.actor, w.account.id))[0]!.active).toBe(false);
  });

  it("refuses a contact of another account, a contact with no email, and a member who cannot edit the account", async () => {
    const w = await world("PortalRefuse");
    await expect(
      issuePortalLink(w.actor, { accountId: w.account.id, contactId: w.outsider.id }),
    ).rejects.toThrow();
    await expect(
      issuePortalLink(w.actor, { accountId: w.account.id, contactId: w.noEmail.id }),
    ).rejects.toThrow(/email/);
    await expect(
      issuePortalLink(w.csm, { accountId: w.account.id, contactId: w.contact.id }),
    ).rejects.toThrow();
    expect(await w.db.portalAccess.count()).toBe(0);
  });

  it("revoking needs the same account: an id from another account changes nothing", async () => {
    const w = await world("PortalRevokeScope");
    const { url } = await issuePortalLink(w.actor, {
      accountId: w.account.id,
      contactId: w.contact.id,
    });
    const [link] = await listPortalLinks(w.actor, w.account.id);
    const otherAccount = await w.db.account.findFirstOrThrow({
      where: { name: "PortalRevokeScope Other" },
    });
    await expect(
      revokePortalLink(w.actor, { accountId: otherAccount.id, portalAccessId: link!.id }),
    ).rejects.toThrow();
    expect((await getPortalView(url.split("/portal/")[1]!)).account.id).toBe(w.account.id);
  });
});

describe("the portal shows the shared plan's goals", () => {
  it("each shared plan carries its goals with status; an internal plan shows nothing", async () => {
    const w = await world("PortalGoals");
    const shared = await w.db.successPlan.create({
      data: {
        workspaceId: w.actor.workspaceId,
        accountId: w.account.id,
        title: "FY27 finance transformation",
        sharedWithPortal: true,
      },
    });
    const internal = await w.db.successPlan.create({
      data: { workspaceId: w.actor.workspaceId, accountId: w.account.id, title: "Internal" },
    });
    for (const [planId, text, status] of [
      [shared.id, "Close the books in five days", "ACHIEVED"],
      [shared.id, "Automate reconciliations", "OPEN"],
      [shared.id, "Old idea", "DROPPED"],
      [internal.id, "Private goal", "OPEN"],
    ] as const)
      await w.db.goal.create({
        data: {
          workspaceId: w.actor.workspaceId,
          accountId: w.account.id,
          successPlanId: planId,
          text,
          status,
        },
      });
    const { url } = await issuePortalLink(w.actor, {
      accountId: w.account.id,
      contactId: w.contact.id,
    });
    const view = await getPortalView(url.split("/portal/")[1]!);
    expect(view.successPlans.map((p) => p.title)).toEqual(["FY27 finance transformation"]);
    expect(view.successPlans[0]!.goals.map((g) => [g.text, g.status])).toEqual([
      ["Close the books in five days", "ACHIEVED"],
      ["Automate reconciliations", "OPEN"],
    ]);
  });
});
