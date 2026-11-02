import { randomUUID } from "node:crypto";
import { rawDb } from "@/lib/db/raw";

/** Creates an isolated workspace + one admin user for integration tests. Global tables only. */
export async function createTestWorkspace(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const workspace = await rawDb.workspace.create({
    data: { name: `${label} ${suffix}`, slug: `${label.toLowerCase()}-${suffix}` },
  });
  const user = await rawDb.user.create({
    data: { email: `${label.toLowerCase()}-${suffix}@example.test`, name: `${label} Admin` },
  });
  return { workspace, user };
}

/** A workspace with an Admin member, shaped as the Actor that services receive. */
export async function createTestAdmin(label: string) {
  const { workspace, user } = await createTestWorkspace(label);
  const membership = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
    return tx.membership.create({
      data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN", canViewRevenue: true },
    });
  });
  const actor = {
    workspaceId: workspace.id,
    userId: user.id,
    membershipId: membership.id,
    role: membership.role,
    canViewRevenue: membership.canViewRevenue,
    bookScope: membership.bookScope,
    user: { id: user.id, email: user.email, name: user.name },
  };
  return { workspace, user, membership, actor };
}
