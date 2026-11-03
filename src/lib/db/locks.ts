import { rawDb } from "./raw";

/**
 * A database-wide mutex (D-68): a Postgres transaction-level advisory lock, held by one open
 * transaction while `fn` runs on other connections. Used where two processes doing the same
 * whole-database job at once would collide (the demo seed: e2e setup, `pnpm db:seed`, seed tests).
 * Not tenant data, so no workspace scope; it lives here because raw SQL does (D-40).
 */
export async function withDatabaseLock<T>(
  name: string,
  fn: () => Promise<T>,
  timeoutMs = 600_000,
): Promise<T> {
  return rawDb.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name}))`;
      return fn();
    },
    { maxWait: timeoutMs, timeout: timeoutMs },
  );
}

/**
 * A transaction-level advisory lock inside the caller's (tenant) transaction: concurrent callers
 * with the same name queue behind it until that transaction ends. Used by integration ingest so
 * two syncs of one integration cannot both create the same new record.
 */
export async function lockInTransaction(
  tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<number> },
  name: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name}))`;
}
