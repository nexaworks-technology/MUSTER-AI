// Fixture for the D-40 lint rule: the filter compares to something that is not a workspace id.
declare const db: { $executeRaw: (...a: unknown[]) => Promise<unknown> };
declare const accountId: string;
export const n = db.$executeRaw`UPDATE "Account" SET x = 1 WHERE "workspaceId" = ${accountId}`;
