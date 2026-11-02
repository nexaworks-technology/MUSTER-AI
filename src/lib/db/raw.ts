import { PrismaClient } from "@prisma/client";

/**
 * The unscoped Prisma client. Import-restricted by ESLint to src/lib/db, src/lib/auth, prisma/
 * and the outbox dispatcher (ARCHITECTURE §7.1). Everything else uses scopedDb(ctx).
 * Connects as app_user, so Postgres RLS still applies to every [W] table.
 */
const globalForDb = globalThis as typeof globalThis & { __nexaworksRawDb?: PrismaClient };

/** Query events are emitted only in tests, for the query-budget (no N+1) checks. */
function createClient(): PrismaClient {
  if (process.env.NODE_ENV === "test") {
    return new PrismaClient({
      log: [{ emit: "event", level: "query" }, "warn", "error"],
    }) as unknown as PrismaClient;
  }
  return new PrismaClient({ log: ["warn", "error"] });
}

export const rawDb: PrismaClient = globalForDb.__nexaworksRawDb ?? createClient();

if (process.env.NODE_ENV !== "production") globalForDb.__nexaworksRawDb = rawDb;
