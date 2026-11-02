import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { hashInvitationToken } from "@/lib/auth/invitations";
import { readOwnMemberships } from "@/lib/auth/identity";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import {
  acceptInvitationAsNewUser,
  createInvitation,
  deactivateMembership,
  getInvitationState,
  listMembers,
  updateMembership,
  updateWorkspaceProfile,
  UserFacingError,
  type Actor,
} from "../service";

/** Pulls the invite link token out of the newest dev-mail file sent to `to`. */
async function tokenFromDevMail(to: string): Promise<string> {
  const dir = path.join(process.cwd(), ".dev-mail");
  const files = (await readdir(dir)).sort().reverse();
  for (const f of files) {
    const mail = JSON.parse(await readFile(path.join(dir, f), "utf8")) as {
      to: string;
      text: string;
    };
    if (mail.to === to) return /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
  }
  throw new Error(`no dev mail for ${to}`);
}

const asRole = (actor: Actor, role: Actor["role"]): Actor => ({ ...actor, role });

describe("invitations", () => {
  it("stores only the token hash, emails the link and audits the invite", async () => {
    const { actor } = await createTestAdmin("Invite");
    const email = `newcsm-${actor.workspaceId}@example.test`;
    const invitation = await createInvitation(actor, {
      email,
      role: "CSM",
      canViewRevenue: false,
      bookScope: "OWN",
    });
    const token = await tokenFromDevMail(email);
    expect(invitation.tokenHash).toBe(hashInvitationToken(token));
    expect(invitation.tokenHash).not.toContain(token);
    const audit = await scopedDb(actor).auditLog.findFirst({
      where: { action: "invitation.created", targetId: invitation.id },
    });
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("accepting creates the user and membership, marks the invite used and audits it", async () => {
    const { actor } = await createTestAdmin("Accept");
    const email = `joiner-${actor.workspaceId}@example.test`;
    await createInvitation(actor, { email, role: "CSM", canViewRevenue: false, bookScope: "OWN" });
    const token = await tokenFromDevMail(email);

    const { user, membership } = await acceptInvitationAsNewUser({
      token,
      name: "New CSM",
      password: "a long enough password",
    });
    expect(membership).toMatchObject({
      workspaceId: actor.workspaceId,
      role: "CSM",
      userId: user.id,
    });
    expect(user.passwordHash).toBeTruthy();
    expect((await readOwnMemberships(user.id)).map((m) => m.workspaceId)).toEqual([
      actor.workspaceId,
    ]);
    expect((await getInvitationState(token)).kind).toBe("used");
    await expect(
      acceptInvitationAsNewUser({ token, name: "Again", password: "a long enough password" }),
    ).rejects.toBeInstanceOf(UserFacingError);
    const audit = await scopedDb(actor).auditLog.findFirst({
      where: { action: "invitation.accepted", actorId: user.id },
    });
    expect(audit).not.toBeNull();
  });

  it("an unknown token is invalid", async () => {
    expect((await getInvitationState("x".repeat(43))).kind).toBe("invalid");
  });

  it("refuses to invite someone who is already a member", async () => {
    const { actor } = await createTestAdmin("Dup");
    await expect(
      createInvitation(actor, {
        email: actor.user.email,
        role: "CSM",
        canViewRevenue: false,
        bookScope: "OWN",
      }),
    ).rejects.toThrow(/already a member/);
  });

  it("only admins may invite", async () => {
    const { actor } = await createTestAdmin("Perm");
    await expect(
      createInvitation(asRole(actor, "CS_LEADER"), {
        email: "x@example.test",
        role: "CSM",
        canViewRevenue: false,
        bookScope: "OWN",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("membership changes", () => {
  async function withMember() {
    const admin = await createTestAdmin("Members");
    const email = `member-${admin.actor.workspaceId}@example.test`;
    await createInvitation(admin.actor, {
      email,
      role: "CSM",
      canViewRevenue: false,
      bookScope: "OWN",
    });
    const { membership } = await acceptInvitationAsNewUser({
      token: await tokenFromDevMail(email),
      name: "Member",
      password: "a long enough password",
    });
    return { ...admin, member: membership };
  }

  it("changes role, revenue access and book scope with before/after in the audit row", async () => {
    const { actor, member } = await withMember();
    await updateMembership(actor, {
      membershipId: member.id,
      role: "CSM",
      canViewRevenue: false,
      bookScope: "TEAM",
    });
    const audit = await scopedDb(actor).auditLog.findFirst({
      where: { action: "membership.updated", targetId: member.id },
    });
    expect(audit?.before).toMatchObject({ bookScope: "OWN" });
    expect(audit?.after).toMatchObject({ bookScope: "TEAM" });
  });

  it("a deactivated member loses access to the workspace immediately", async () => {
    const { actor, member } = await withMember();
    await deactivateMembership(actor, member.id);
    expect(await readOwnMemberships(member.userId)).toEqual([]);
  });

  it("never leaves a workspace without an active admin", async () => {
    const { actor } = await createTestAdmin("LastAdmin");
    await expect(
      updateMembership(actor, {
        membershipId: actor.membershipId,
        role: "CSM",
        canViewRevenue: true,
        bookScope: "OWN",
      }),
    ).rejects.toThrow(/at least one active admin/);
    await expect(deactivateMembership(actor, actor.membershipId)).rejects.toThrow(
      /at least one active admin/,
    );
  });

  it("cannot touch a member of another workspace (Rule 2)", async () => {
    const a = await createTestAdmin("CrossA");
    const b = await withMember();
    await expect(
      updateMembership(a.actor, {
        membershipId: b.member.id,
        role: "VIEWER",
        canViewRevenue: false,
        bookScope: "OWN",
      }),
    ).rejects.toThrow(/not found/);
    await expect(deactivateMembership(a.actor, b.member.id)).rejects.toThrow(/not found/);
    expect((await listMembers(a.actor)).every((m) => m.workspaceId === a.actor.workspaceId)).toBe(
      true,
    );
  });
});

describe("workspace profile", () => {
  it("updates name, time zone and currency, and audits the change", async () => {
    const { actor } = await createTestAdmin("Profile");
    const updated = await updateWorkspaceProfile(actor, {
      name: "Renamed",
      timezone: "America/New_York",
      baseCurrency: "EUR",
    });
    expect(updated).toMatchObject({
      name: "Renamed",
      timezone: "America/New_York",
      baseCurrency: "EUR",
    });
    expect(await scopedDb(actor).auditLog.count({ where: { action: "workspace.updated" } })).toBe(
      1,
    );
  });

  it("is admin-only", async () => {
    const { actor } = await createTestAdmin("ProfilePerm");
    await expect(
      updateWorkspaceProfile(asRole(actor, "CSM"), {
        name: "x",
        timezone: "UTC",
        baseCurrency: "USD",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
