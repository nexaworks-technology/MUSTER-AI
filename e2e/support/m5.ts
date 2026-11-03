import { createHmac, randomUUID } from "node:crypto";
import { hashPassword } from "../../src/lib/auth/password";
import { rawDb } from "../../src/lib/db/raw";
import { DEMO_PASSWORD } from "../../prisma/seed/users";

/**
 * M5 e2e support. Each run makes its OWN fresh workspaces still in setup (one Admin each), so the
 * integration and wizard flows never touch the seeded Larkspur world other specs assert on, and a
 * re-run against the same `_test` database never collides (D-36: re-seeded, never reset).
 */
export async function createFreshWorkspace(label: string) {
  const tag = randomUUID().slice(0, 8);
  const slug = `${label.toLowerCase()}-${tag}`;
  const email = `admin+${slug}@juniper.test`;
  const workspace = await rawDb.workspace.create({
    data: {
      name: `${label} ${tag}`,
      slug,
      timezone: "America/New_York",
      baseCurrency: "USD",
      setupPending: true,
    },
  });
  const user = await rawDb.user.create({
    data: { email, name: `${label} Admin`, passwordHash: await hashPassword(DEMO_PASSWORD) },
  });
  await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
    await tx.membership.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        role: "ADMIN",
        canViewRevenue: true,
        bookScope: "ALL",
      },
    });
  });
  return { workspaceId: workspace.id, slug, email };
}

/** The integration row of a provider in a workspace (read under RLS). */
export async function integrationId(
  workspaceId: string,
  provider: "STRIPE" | "HUBSPOT" | "CHARGEBEE" | "SLACK",
) {
  return rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return (
      await tx.integration.findUniqueOrThrow({
        where: { workspaceId_provider: { workspaceId, provider } },
      })
    ).id;
  });
}

/** Counts rows of a workspace (read under RLS). */
export async function countIn(
  workspaceId: string,
  model: "webhookEvent" | "dataQualityIssue" | "auditLog",
  where: Record<string, unknown> = {},
) {
  return rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    // The three delegates share count({ where }).
    return (
      tx[model] as unknown as { count: (a: { where: Record<string, unknown> }) => Promise<number> }
    ).count({ where });
  });
}

/** A Stripe-Signature header for this body, signed now with `secret`. */
export function stripeSignature(body: string, secret: string) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

/**
 * Earlier runs' e2e workspaces stay in `_test` with the fixture Slack team connected, which would
 * (correctly) make that team ambiguous (D-93). Disconnect them first; only workspaces this spec
 * created (by slug prefix) are touched.
 */
export async function retireEarlierSlackConnections(slugPrefix: string) {
  const old = await rawDb.workspace.findMany({
    where: { slug: { startsWith: slugPrefix } },
    select: { id: true },
  });
  for (const w of old)
    await rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${w.id}, true)`;
      await tx.integration.updateMany({
        where: { provider: "SLACK" },
        data: { status: "DISCONNECTED", credentialsEnc: null },
      });
    });
}

/** Makes the workspace's Admin the owner of an account (Today lists a member's own book, D-78). */
export async function assignToAdmin(workspaceId: string, accountName: string) {
  await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    const admin = await tx.membership.findFirstOrThrow({ where: { role: "ADMIN" } });
    await tx.account.updateMany({
      where: { name: accountName },
      data: { ownerMembershipId: admin.id },
    });
  });
}
