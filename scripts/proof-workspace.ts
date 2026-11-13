/**
 * Connector live proof (docs/CONNECTOR-LIVE.md): creates ONE empty workspace for connector proofs.
 * Not product code; run by hand against the target database:
 *
 *   pnpm exec tsx --env-file=<env file> scripts/proof-workspace.ts
 *
 * CREATE-ONLY: refuses to run if the workspace slug or its admin email already exists. It never
 * updates, wipes or reseeds anything; other workspaces (Larkspur) are not touched. The admin user
 * follows the demo seed pattern (same demo password as prisma/seed/users.ts, never printed).
 */
import { writeAudit } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { DEMO_PASSWORD } from "../prisma/seed/users";

const WORKSPACE = {
  name: "Muster Proof",
  slug: "muster-proof",
  timezone: "America/New_York",
  baseCurrency: "USD",
} as const;
const ADMIN = { name: "Proof Admin", email: "admin@muster-proof.test" } as const;

async function main() {
  const [ws, user] = await Promise.all([
    rawDb.workspace.findUnique({ where: { slug: WORKSPACE.slug }, select: { id: true } }),
    rawDb.user.findUnique({ where: { email: ADMIN.email }, select: { id: true } }),
  ]);
  if (ws) throw new Error(`Workspace "${WORKSPACE.slug}" already exists; refusing (create-only).`);
  if (user) throw new Error(`User ${ADMIN.email} already exists; refusing (create-only).`);

  const workspace = await rawDb.workspace.create({ data: { ...WORKSPACE, setupPending: false } });
  const created = await rawDb.user.create({
    data: { email: ADMIN.email, name: ADMIN.name, passwordHash: await hashPassword(DEMO_PASSWORD) },
  });
  const db = scopedDb({ workspaceId: workspace.id });
  await db.membership.create({
    data: {
      workspaceId: workspace.id,
      userId: created.id,
      role: "ADMIN",
      canViewRevenue: true,
      bookScope: "ALL",
      status: "ACTIVE",
    },
  });
  await db.workspaceSettings.create({ data: { workspaceId: workspace.id, data: {} } });
  await writeAudit({
    workspaceId: workspace.id,
    actorType: "SYSTEM",
    action: "proof.workspace.created",
    summary: "Connector proof workspace created (create-only script)",
  });
  console.log(`created workspace "${WORKSPACE.name}" (${WORKSPACE.slug}) ${workspace.id}`);
  console.log(`admin: ${ADMIN.email} (demo seed password, see prisma/seed/users.ts)`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => rawDb.$disconnect());
