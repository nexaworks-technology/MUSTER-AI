// Fixture for the D-40 lint rule: the unsafe raw methods are refused.
declare const db: { $queryRawUnsafe: (q: string) => Promise<unknown> };
export const rows = db.$queryRawUnsafe('SELECT * FROM "Account"');
