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
