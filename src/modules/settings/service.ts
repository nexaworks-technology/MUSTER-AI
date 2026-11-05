import type { Membership, Role, User } from "@prisma/client";
import type { z } from "zod";
import { writeAudit } from "@/lib/audit";
import {
  findInvitationByToken,
  newInvitationToken,
  type InvitationWithWorkspace,
} from "@/lib/auth/invitations";
import { hashPassword } from "@/lib/auth/password";
import { requirePermission } from "@/lib/auth/permissions";
import type { WorkspaceContext } from "@/lib/auth/session";
import { env } from "@/lib/config/env";
import { scopedDb } from "@/lib/db/scoped";
import { getOwnWorkspace, updateOwnWorkspace } from "@/lib/db/workspace";
import { sendStaffEmail } from "@/lib/email";
import { PRODUCT_NAME } from "@/config/product";
import {
  workspaceSettingsData,
  type WorkspaceSettingsData,
  ROLE_LABELS,
  type acceptAsNewUserInput,
  type inviteInput,
  type updateMembershipInput,
  type workspaceProfileInput,
} from "./schemas";

/**
 * Settings › Users and Settings › Workspace (spec §6N5, ARCHITECTURE §2 `settings`).
 * Every function checks permission server-side, uses scopedDb, and writes an audit row.
 */
export type Actor = Pick<
  WorkspaceContext,
  "workspaceId" | "userId" | "membershipId" | "role" | "canViewRevenue" | "bookScope" | "user"
>;

/** A failure the user can act on; its message is safe to show in the UI. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

export const INVITATION_TTL_DAYS = 7;

export type MemberRow = Membership & { user: Pick<User, "id" | "email" | "name"> };

export async function listMembers(actor: Actor): Promise<MemberRow[]> {
  requirePermission(actor, "workspace:manageUsers");
  return scopedDb(actor).membership.findMany({
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
  });
}

export async function listPendingInvitations(actor: Actor) {
  requirePermission(actor, "workspace:manageUsers");
  return scopedDb(actor).invitation.findMany({
    where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
}

export async function createInvitation(actor: Actor, input: z.infer<typeof inviteInput>) {
  requirePermission(actor, "workspace:manageUsers");
  const db = scopedDb(actor);
  const existing = await db.membership.findFirst({
    where: { status: "ACTIVE", user: { email: input.email } },
  });
  if (existing) throw new UserFacingError(`${input.email} is already a member of this workspace.`);

  const { token, tokenHash } = newInvitationToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000);
  const invitation = await db.$tenantTransaction(async (tx) => {
    // A new invitation replaces any earlier pending one for the same email.
    await tx.invitation.updateMany({
      where: { email: input.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const created = await tx.invitation.create({
      data: {
        workspaceId: actor.workspaceId,
        email: input.email,
        role: input.role,
        canViewRevenue: input.canViewRevenue,
        bookScope: input.bookScope,
        tokenHash,
        expiresAt,
        invitedByMembershipId: actor.membershipId,
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "invitation.created",
        targetType: "Invitation",
        targetId: created.id,
        summary: `Invited ${input.email} as ${ROLE_LABELS[input.role]}`,
        after: {
          email: input.email,
          role: input.role,
          canViewRevenue: input.canViewRevenue,
          bookScope: input.bookScope,
        },
      },
      tx,
    );
    return created;
  });

  const workspace = await getOwnWorkspace(actor);
  const link = new URL(`/invite/${token}`, env().APP_URL).toString();
  const inviter = actor.user.name ?? actor.user.email;
  await sendStaffEmail({
    to: input.email,
    subject: `${inviter} invited you to ${workspace.name} on ${PRODUCT_NAME}`,
    text: [
      `${inviter} invited you to join ${workspace.name} on ${PRODUCT_NAME} as ${ROLE_LABELS[input.role]}.`,
      "",
      `Accept the invitation: ${link}`,
      "",
      `This link expires on ${expiresAt.toUTCString()}. If you weren't expecting it, you can ignore this email.`,
    ].join("\n"),
  });
  return invitation;
}

export async function revokeInvitation(actor: Actor, invitationId: string): Promise<void> {
  requirePermission(actor, "workspace:manageUsers");
  await scopedDb(actor).$tenantTransaction(async (tx) => {
    const { count } = await tx.invitation.updateMany({
      where: { id: invitationId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new UserFacingError("That invitation is no longer pending.");
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "invitation.revoked",
        targetType: "Invitation",
        targetId: invitationId,
        summary: "Revoked an invitation",
      },
      tx,
    );
  });
}

type Tx = Parameters<Parameters<ReturnType<typeof scopedDb>["$tenantTransaction"]>[0]>[0];

async function assertAdminRemains(
  tx: Tx,
  target: Membership,
  next: { role: Role; active: boolean },
) {
  const losesAdmin =
    target.role === "ADMIN" &&
    target.status === "ACTIVE" &&
    (next.role !== "ADMIN" || !next.active);
  if (!losesAdmin) return;
  const admins = await tx.membership.count({ where: { role: "ADMIN", status: "ACTIVE" } });
  if (admins <= 1) throw new UserFacingError("A workspace needs at least one active admin.");
}

export async function updateMembership(actor: Actor, input: z.infer<typeof updateMembershipInput>) {
  requirePermission(actor, "workspace:manageUsers");
  return scopedDb(actor).$tenantTransaction(async (tx) => {
    const target = await tx.membership.findUnique({
      where: { id: input.membershipId },
      include: { user: true },
    });
    if (!target) throw new UserFacingError("That member was not found in this workspace.");
    await assertAdminRemains(tx, target, { role: input.role, active: target.status === "ACTIVE" });
    const before = {
      role: target.role,
      canViewRevenue: target.canViewRevenue,
      bookScope: target.bookScope,
    };
    const after = {
      role: input.role,
      canViewRevenue: input.canViewRevenue,
      bookScope: input.bookScope,
    };
    const updated = await tx.membership.update({ where: { id: target.id }, data: after });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "membership.updated",
        targetType: "Membership",
        targetId: target.id,
        summary: `Changed access for ${target.user.email}`,
        before,
        after,
      },
      tx,
    );
    return updated;
  });
}

export async function deactivateMembership(actor: Actor, membershipId: string) {
  requirePermission(actor, "workspace:manageUsers");
  return scopedDb(actor).$tenantTransaction(async (tx) => {
    const target = await tx.membership.findUnique({
      where: { id: membershipId },
      include: { user: true },
    });
    if (!target) throw new UserFacingError("That member was not found in this workspace.");
    if (target.status === "DEACTIVATED") return target;
    await assertAdminRemains(tx, target, { role: target.role, active: false });
    const updated = await tx.membership.update({
      where: { id: target.id },
      data: { status: "DEACTIVATED" },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "membership.deactivated",
        targetType: "Membership",
        targetId: target.id,
        summary: `Deactivated ${target.user.email}`,
        before: { status: target.status },
        after: { status: "DEACTIVATED" },
      },
      tx,
    );
    return updated;
  });
}

// ─── Invitation acceptance (no workspace context yet: the token decides the workspace) ───────

export type InvitationState =
  | { kind: "invalid" }
  | { kind: "expired" | "used" | "revoked"; workspaceName: string }
  | { kind: "pending"; invitation: InvitationWithWorkspace; hasAccount: boolean };

export async function getInvitationState(token: string): Promise<InvitationState> {
  const invitation = await findInvitationByToken(token);
  if (!invitation) return { kind: "invalid" };
  const workspaceName = invitation.workspace.name;
  if (invitation.revokedAt) return { kind: "revoked", workspaceName };
  if (invitation.acceptedAt) return { kind: "used", workspaceName };
  if (invitation.expiresAt <= new Date()) return { kind: "expired", workspaceName };
  const hasAccount = Boolean(
    await scopedDb({ workspaceId: invitation.workspaceId }).user.findUnique({
      where: { email: invitation.email },
    }),
  );
  return { kind: "pending", invitation, hasAccount };
}

async function acceptPending(
  invitation: InvitationWithWorkspace,
  resolveUser: (tx: Tx) => Promise<User>,
): Promise<{ user: User; membership: Membership }> {
  return scopedDb({ workspaceId: invitation.workspaceId }).$tenantTransaction(async (tx) => {
    // Claim the invitation first so two concurrent accepts cannot both succeed.
    const { count } = await tx.invitation.updateMany({
      where: {
        id: invitation.id,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { acceptedAt: new Date() },
    });
    if (count === 0)
      throw new UserFacingError("This invitation has already been used or has expired.");
    const user = await resolveUser(tx);
    await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedUserId: user.id } });
    const access = {
      role: invitation.role,
      canViewRevenue: invitation.canViewRevenue,
      bookScope: invitation.bookScope,
    };
    const membership = await tx.membership.upsert({
      where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: user.id } },
      create: { workspaceId: invitation.workspaceId, userId: user.id, ...access },
      update: { ...access, status: "ACTIVE" },
    });
    await writeAudit(
      {
        workspaceId: invitation.workspaceId,
        actorType: "USER",
        actorId: user.id,
        action: "invitation.accepted",
        targetType: "Membership",
        targetId: membership.id,
        summary: `${user.email} joined as ${ROLE_LABELS[invitation.role]}`,
        after: access,
      },
      tx,
    );
    return { user, membership };
  });
}

export async function acceptInvitationAsNewUser(input: z.infer<typeof acceptAsNewUserInput>) {
  const state = await getInvitationState(input.token);
  if (state.kind !== "pending") throw new UserFacingError("This invitation can no longer be used.");
  if (state.hasAccount)
    throw new UserFacingError("An account with this email already exists. Sign in to accept.");
  const passwordHash = await hashPassword(input.password);
  const { invitation } = state;
  return acceptPending(invitation, (tx) =>
    tx.user.create({ data: { email: invitation.email, name: input.name, passwordHash } }),
  );
}

export async function acceptInvitationAsExistingUser(
  token: string,
  sessionUser: { id: string; email: string },
) {
  const state = await getInvitationState(token);
  if (state.kind !== "pending") throw new UserFacingError("This invitation can no longer be used.");
  if (state.invitation.email !== sessionUser.email.toLowerCase()) {
    throw new UserFacingError(
      `This invitation is for ${state.invitation.email}. Sign in with that email to accept it.`,
    );
  }
  return acceptPending(state.invitation, (tx) =>
    tx.user.findUniqueOrThrow({ where: { id: sessionUser.id } }),
  );
}

// ─── Settings › Workspace ──────────────────────────────────────────────────────────────────

export async function updateWorkspaceProfile(
  actor: Actor,
  input: z.infer<typeof workspaceProfileInput>,
) {
  requirePermission(actor, "workspace:manageSettings");
  const before = await getOwnWorkspace(actor);
  const updated = await updateOwnWorkspace(actor, input);
  await writeAudit({
    workspaceId: actor.workspaceId,
    actorType: "USER",
    actorId: actor.userId,
    action: "workspace.updated",
    targetType: "Workspace",
    targetId: actor.workspaceId,
    summary: "Updated workspace profile",
    before: { name: before.name, timezone: before.timezone, baseCurrency: before.baseCurrency },
    after: input,
  });
  return updated;
}

// ─── Typed workspace settings ───────────────────────────────────────────────

export const CONFIRM_ENABLE_AUTO_SEND = "ENABLE AUTO-SEND";

export interface EnableAutoSendInput {
  confirmation: string;
}

/**
 * Admin-only: enables auto-send workspace-wide (spec §6J4, ARCHITECTURE §7.2).
 * Requires typed confirmation "ENABLE AUTO-SEND" and writes an AuditLog row.
 */
export async function enableAutoSend(actor: Actor, input: EnableAutoSendInput) {
  requirePermission(actor, "plays:enableAutoSend");
  if (input.confirmation !== CONFIRM_ENABLE_AUTO_SEND) {
    throw new Error(`Typed confirmation required: type "${CONFIRM_ENABLE_AUTO_SEND}" to enable.`);
  }

  const db = scopedDb(actor);
  const existing = await getSettingsData(actor.workspaceId);
  const updatedOutbound = {
    ...existing.outbound,
    autoSendEnabled: true,
  };
  const updatedApprovals = {
    ...existing.approvals,
    workspaceCeiling: "SEND_AUTOMATICALLY" as const,
  };

  const updatedData = {
    ...existing,
    outbound: updatedOutbound,
    approvals: updatedApprovals,
  };

  await db.$tenantTransaction(async (tx) => {
    await tx.workspaceSettings.upsert({
      where: { workspaceId: actor.workspaceId },
      create: {
        workspaceId: actor.workspaceId,
        data: updatedData,
      },
      update: {
        data: updatedData,
      },
    });

    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "settings.auto_send_enabled",
        targetType: "WorkspaceSettings",
        targetId: actor.workspaceId,
        summary: "Enabled auto-send for plays and outbound customer communications",
        after: { autoSendEnabled: true },
      },
      tx,
    );
  });

  return { autoSendEnabled: true };
}

/**
 * Admin-only: disables auto-send workspace-wide (kill switch, guard 8).
 */
export async function disableAutoSend(actor: Actor) {
  requirePermission(actor, "plays:enableAutoSend");
  const db = scopedDb(actor);
  const existing = await getSettingsData(actor.workspaceId);
  const updatedOutbound = {
    ...existing.outbound,
    autoSendEnabled: false,
  };

  const updatedData = {
    ...existing,
    outbound: updatedOutbound,
  };

  await db.$tenantTransaction(async (tx) => {
    await tx.workspaceSettings.upsert({
      where: { workspaceId: actor.workspaceId },
      create: {
        workspaceId: actor.workspaceId,
        data: updatedData,
      },
      update: {
        data: updatedData,
      },
    });

    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "settings.auto_send_disabled",
        targetType: "WorkspaceSettings",
        targetId: actor.workspaceId,
        summary: "Disabled auto-send for plays and outbound communications",
        after: { autoSendEnabled: false },
      },
      tx,
    );
  });

  return { autoSendEnabled: false };
}

/**
 * Admin-only (`workspace:manageSettings`): turns the browser-dictation button on Ask AI on or off
 * (Q-11). Nothing server-side processes audio. Audited.
 */
export async function setVoiceDictation(actor: Actor, enabled: boolean) {
  requirePermission(actor, "workspace:manageSettings");
  const existing = await getSettingsData(actor.workspaceId);
  const data = { ...existing, ask: { ...existing.ask, voiceDictation: enabled } };
  await scopedDb(actor).$tenantTransaction(async (tx) => {
    await tx.workspaceSettings.upsert({
      where: { workspaceId: actor.workspaceId },
      create: { workspaceId: actor.workspaceId, data },
      update: { data },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "settings.voice_dictation_changed",
        targetType: "WorkspaceSettings",
        targetId: actor.workspaceId,
        summary: `${enabled ? "Turned on" : "Turned off"} browser dictation in Ask AI`,
        before: { voiceDictation: existing.ask.voiceDictation },
        after: { voiceDictation: enabled },
      },
      tx,
    );
  });
  return { voiceDictation: enabled };
}

/** Reads WorkspaceSettings.data with every default applied (no row = all defaults). */
export async function getSettingsData(workspaceId: string): Promise<WorkspaceSettingsData> {
  const row = await scopedDb({ workspaceId }).workspaceSettings.findUnique({
    where: { workspaceId },
  });
  const parsed = workspaceSettingsData.safeParse(row?.data ?? {});
  return parsed.success ? parsed.data : workspaceSettingsData.parse({});
}
