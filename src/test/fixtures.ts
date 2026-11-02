import { randomUUID } from "node:crypto";
import { rawDb } from "@/lib/db/raw";

/** Creates an isolated workspace + one admin user for integration tests. Global tables only. */
export async function createTestWorkspace(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const workspace = await rawDb.workspace.create({
    data: { name: `${label} ${suffix}`, slug: `${label.toLowerCase()}-${suffix}` },
  });
  const user = await rawDb.user.create({
    data: { email: `${label.toLowerCase()}-${suffix}@example.test`, name: `${label} Admin` },
  });
  return { workspace, user };
}
