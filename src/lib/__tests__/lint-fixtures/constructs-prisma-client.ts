// Deliberate violation: constructing an unscoped client outside src/lib/db.
import { PrismaClient } from "@prisma/client";

export const db = new PrismaClient();
