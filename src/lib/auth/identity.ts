import type { Membership, Workspace } from "@prisma/client";
import { rawDb } from "@/lib/db/raw";

/**
 * Identity reads that happen before a workspace is known. They run under the narrow
 * `membership_self_read` RLS policy (prisma/README.md): a user can see only their own memberships.
 */
export type MembershipWithWorkspace = Membership & { workspace: Workspace };

export async function readOwnMemberships(userId: string): Promise<MembershipWithWorkspace[]> {
  const [, memberships] = await rawDb.$transaction([
    rawDb.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`,
    rawDb.membership.findMany({
      where: { userId, status: "ACTIVE" },
      include: { workspace: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  return memberships.filter((m) => m.workspace.status === "ACTIVE");
}
