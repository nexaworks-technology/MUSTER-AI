import { rawDb } from "./raw";

/** Liveness probe for /api/health: a trivial global query, no tenant data (M12 B4). */
export async function pingDatabase(): Promise<void> {
  await rawDb.$queryRaw`SELECT 1`;
}
