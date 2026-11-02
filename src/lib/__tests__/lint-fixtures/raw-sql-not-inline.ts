// Fixture for the D-40 lint rule: a prebuilt query cannot be checked, so it is refused.
declare const db: { $queryRaw: (q: unknown) => Promise<unknown> };
declare const query: unknown;
export const rows = db.$queryRaw(query);
