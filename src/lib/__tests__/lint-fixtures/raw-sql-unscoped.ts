// Fixture for the D-40 lint rule: raw SQL with no workspace filter.
declare const db: { $queryRaw: (...a: unknown[]) => Promise<unknown> };
declare const accountId: string;
export const rows = db.$queryRaw`SELECT * FROM "UsageDaily" WHERE "accountId" = ${accountId}`;
