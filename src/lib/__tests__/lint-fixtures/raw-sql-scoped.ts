// Fixture for the D-40 lint rule: both accepted shapes (tagged and Prisma.sql).
declare const db: {
  $queryRaw: (...a: unknown[]) => Promise<unknown>;
  $executeRaw: (...a: unknown[]) => Promise<unknown>;
};
declare const Prisma: { sql: (...a: unknown[]) => unknown };
declare const ctx: { workspaceId: string };
declare const workspaceId: string;
export const a = db.$queryRaw`SELECT 1 FROM "UsageDaily" u WHERE u."workspaceId" = ${ctx.workspaceId}`;
export const b = db.$queryRaw(
  Prisma.sql`SELECT 1 FROM "Ticket" WHERE "workspaceId" = ${workspaceId}`,
);
export const c = db.$executeRaw`UPDATE "Account" SET x = 1 WHERE "workspaceId" = ${workspaceId}`;
