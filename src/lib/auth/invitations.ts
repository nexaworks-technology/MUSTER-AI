import { createHash, randomBytes } from "node:crypto";
import type { Invitation, Workspace } from "@prisma/client";
import { rawDb } from "@/lib/db/raw";

/**
 * Invitation tokens: 32 random bytes shown once in the invite link; only the SHA-256 is stored.
 * Lookup by token runs under the narrow `invitation_token_read` RLS policy (prisma/README.md).
 */
export function newInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type InvitationWithWorkspace = Invitation & {
  workspace: Workspace;
  invitedBy: { user: { name: string | null; email: string } };
};

export async function findInvitationByToken(
  token: string,
): Promise<InvitationWithWorkspace | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const tokenHash = hashInvitationToken(token);
  const [, invitation] = await rawDb.$transaction([
    rawDb.$executeRaw`SELECT set_config('app.invite_token_hash', ${tokenHash}, true)`,
    rawDb.invitation.findUnique({ where: { tokenHash } }),
  ]);
  if (!invitation) return null;
  // The inviter's membership + workspace are read once the workspace is known.
  const [, details] = await rawDb.$transaction([
    rawDb.$executeRaw`SELECT set_config('app.workspace_id', ${invitation.workspaceId}, true)`,
    rawDb.invitation.findUniqueOrThrow({
      where: { id: invitation.id },
      include: {
        workspace: true,
        invitedBy: { include: { user: { select: { name: true, email: true } } } },
      },
    }),
  ]);
  return details;
}
