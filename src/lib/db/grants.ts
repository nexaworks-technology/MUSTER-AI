/**
 * src/lib/db/grants.ts
 *
 * Database role grant reconciliation (docker/postgres/grants.sql).
 * Executes schema-level grants to ensure app_user maintains row read/write permissions
 * while nexaworks_owner owns schema DDL (M12 A3, ARCHITECTURE §7.1).
 */
import { PrismaClient } from "@prisma/client";

export async function applyDatabaseGrants(databaseUrl?: string): Promise<void> {
  const url = databaseUrl || process.env.DATABASE_URL_MIGRATE || process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL_MIGRATE or DATABASE_URL must be defined");
  }

  const prisma = new PrismaClient({
    datasources: { db: { url } },
  });

  try {
    // Base schema-level privileges from docker/postgres/grants.sql
    await prisma.$executeRaw`REVOKE CREATE ON SCHEMA public FROM PUBLIC;`;
    await prisma.$executeRaw`ALTER SCHEMA public OWNER TO nexaworks_owner;`;
    await prisma.$executeRaw`GRANT USAGE ON SCHEMA public TO app_user;`;
    await prisma.$executeRaw`ALTER DEFAULT PRIVILEGES FOR ROLE nexaworks_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;`;
    await prisma.$executeRaw`ALTER DEFAULT PRIVILEGES FOR ROLE nexaworks_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;`;
    await prisma.$executeRaw`ALTER DEFAULT PRIVILEGES FOR ROLE nexaworks_owner IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app_user;`;

    // Ensure all existing tables, sequences, and functions also have grants
    await prisma.$executeRaw`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;`;
    await prisma.$executeRaw`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;`;
    await prisma.$executeRaw`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user;`;
  } finally {
    await prisma.$disconnect();
  }
}
