import type { BookScope, Role } from "@prisma/client";
import { cookies } from "next/headers";
import { rawDb } from "@/lib/db/raw";
import { readOwnMemberships, type MembershipWithWorkspace } from "./identity";

/**
 * Server-side session and workspace context (ARCHITECTURE §1.1 steps 2–3). The workspace always
 * comes from the user's own memberships, never from client input.
 */
export const SESSION_COOKIE_NAMES = [
  "__Secure-authjs.session-token",
  "authjs.session-token",
] as const;

export interface SessionInfo {
  sessionToken: string;
  userId: string;
  activeWorkspaceId: string | null;
  user: { id: string; email: string; name: string | null };
}

export interface WorkspaceContext {
  userId: string;
  user: SessionInfo["user"];
  workspaceId: string;
  workspace: { id: string; name: string; slug: string; timezone: string; baseCurrency: string };
  membershipId: string;
  role: Role;
  canViewRevenue: boolean;
  bookScope: BookScope;
  /** Other workspaces this user may switch to. */
  workspaces: Array<{ id: string; name: string }>;
}

export async function findSessionByToken(sessionToken: string): Promise<SessionInfo | null> {
  const session = await rawDb.session.findUnique({
    where: { sessionToken },
    include: { user: true },
  });
  if (!session || session.expires <= new Date()) return null;
  return {
    sessionToken,
    userId: session.userId,
    activeWorkspaceId: session.activeWorkspaceId,
    user: { id: session.user.id, email: session.user.email, name: session.user.name },
  };
}

export async function getSession(): Promise<SessionInfo | null> {
  const jar = await cookies();
  for (const name of SESSION_COOKIE_NAMES) {
    const token = jar.get(name)?.value;
    if (token) return findSessionByToken(token);
  }
  return null;
}

/** Pure choice of the active membership: the session's choice if still valid, else the oldest. */
export function chooseMembership(
  memberships: readonly MembershipWithWorkspace[],
  activeWorkspaceId: string | null,
): MembershipWithWorkspace | null {
  return memberships.find((m) => m.workspaceId === activeWorkspaceId) ?? memberships[0] ?? null;
}

export function toWorkspaceContext(
  session: SessionInfo,
  membership: MembershipWithWorkspace,
  memberships: readonly MembershipWithWorkspace[],
): WorkspaceContext {
  const w = membership.workspace;
  return {
    userId: session.userId,
    user: session.user,
    workspaceId: membership.workspaceId,
    workspace: {
      id: w.id,
      name: w.name,
      slug: w.slug,
      timezone: w.timezone,
      baseCurrency: w.baseCurrency,
    },
    membershipId: membership.id,
    role: membership.role,
    canViewRevenue: membership.canViewRevenue,
    bookScope: membership.bookScope,
    workspaces: memberships.map((m) => ({ id: m.workspaceId, name: m.workspace.name })),
  };
}

export async function resolveWorkspaceContext(
  session: SessionInfo,
): Promise<WorkspaceContext | null> {
  const memberships = await readOwnMemberships(session.userId);
  const membership = chooseMembership(memberships, session.activeWorkspaceId);
  if (!membership) return null;
  if (membership.workspaceId !== session.activeWorkspaceId) {
    await rawDb.session.update({
      where: { sessionToken: session.sessionToken },
      data: { activeWorkspaceId: membership.workspaceId },
    });
  }
  return toWorkspaceContext(session, membership, memberships);
}

export async function getWorkspaceContext(): Promise<WorkspaceContext | null> {
  const session = await getSession();
  return session ? resolveWorkspaceContext(session) : null;
}

/** Switches the session's workspace; refuses workspaces the user is not an active member of. */
export async function setActiveWorkspace(
  session: SessionInfo,
  workspaceId: string,
): Promise<boolean> {
  const memberships = await readOwnMemberships(session.userId);
  if (!memberships.some((m) => m.workspaceId === workspaceId)) return false;
  await rawDb.session.update({
    where: { sessionToken: session.sessionToken },
    data: { activeWorkspaceId: workspaceId },
  });
  return true;
}
