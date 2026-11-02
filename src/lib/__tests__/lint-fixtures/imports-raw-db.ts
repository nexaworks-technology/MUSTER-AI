// Deliberate violation: a feature module reaching for the unscoped Prisma client.
import { rawDb } from "@/lib/db/raw";

export const leak = rawDb;
