import { writeAudit } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { seedAccounts } from "./demo/accounts";
import { seedCommercial } from "./demo/commercial";
import { seedUsage } from "./demo/usage";
import { seedConversations } from "./demo/conversations";
import { seedWork } from "./demo/work";
import { recomputeLastTouch } from "@/modules/accounts/service";
import { seedId } from "./demo/ids";
import {
  DEMO_PASSWORD,
  DEMO_USERS,
  DEMO_WORKSPACE,
  TEST_TENANT,
  TEST_TENANT_USERS,
  type SeedUser,
} from "./users";

/**
 * Deterministic seed (docs/SEED_DATA.md §1): stable ids derived from seed keys, upserts only.
 * AuditLog is append-only, so the seed never deletes a workspace: re-running resets the seeded
 * workspaces' profiles and the seeded users' access, and leaves anything else untouched.
 */
export const SEED_TODAY = process.env.SEED_TODAY ?? "2026-11-02";

export { seedId };

async function seedWorkspace(
  ws: typeof DEMO_WORKSPACE | typeof TEST_TENANT,
  users: readonly SeedUser[],
) {
  const { key, ...profile } = ws;
  const workspace = await rawDb.workspace.upsert({
    where: { slug: ws.slug },
    create: { id: seedId(key), ...profile },
    update: {
      name: profile.name,
      timezone: profile.timezone,
      baseCurrency: profile.baseCurrency,
      status: "ACTIVE",
    },
  });
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const db = scopedDb({ workspaceId: workspace.id });

  for (const u of users) {
    const user = await rawDb.user.upsert({
      where: { email: u.email },
      create: { id: seedId(u.key), email: u.email, name: u.name, passwordHash },
      update: { name: u.name, passwordHash },
    });
    const access = {
      role: u.role,
      canViewRevenue: u.canViewRevenue,
      bookScope: u.bookScope,
      status: "ACTIVE" as const,
    };
    await db.membership.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      create: {
        id: seedId(`${key}:${u.key}`),
        workspaceId: workspace.id,
        userId: user.id,
        ...access,
      },
      update: access,
    });
  }
  await db.workspaceSettings.upsert({
    where: { workspaceId: workspace.id },
    create: { workspaceId: workspace.id, data: {} },
    update: {},
  });
  await writeAudit({
    workspaceId: workspace.id,
    actorType: "SYSTEM",
    action: "seed.applied",
    summary: `Demo seed applied (SEED_TODAY ${SEED_TODAY}, ${users.length} users)`,
  });
  return workspace;
}

async function seedDemoData(workspaceId: string): Promise<void> {
  const db = scopedDb({ workspaceId });
  await seedAccounts(db, workspaceId);
  await seedCommercial(db, workspaceId);
  await seedUsage(db, workspaceId);
  await seedConversations(db, workspaceId);
  await seedWork(db, workspaceId);
  await recomputeLastTouch(db, workspaceId);
}

export async function runSeed({ includeTestTenant }: { includeTestTenant: boolean }) {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "true") {
    throw new Error(
      "Refusing to seed demo data in production (set ALLOW_DEMO_SEED=true for a demo environment)",
    );
  }
  const larkspur = await seedWorkspace(DEMO_WORKSPACE, DEMO_USERS);
  // Demo data goes to Larkspur only; Ferngrove stays an empty second tenant (SEED_DATA §2).
  await seedDemoData(larkspur.id);
  const seeded = [larkspur];
  if (includeTestTenant) seeded.push(await seedWorkspace(TEST_TENANT, TEST_TENANT_USERS));
  return seeded;
}
