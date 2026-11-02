/**
 * `pnpm db:seed` — loads the demo workspace (docs/SEED_DATA.md). M1 seeds tenancy only:
 * Larkspur Analytics with five users; `--with-test-tenant` adds Ferngrove Software, the second
 * tenant used by isolation tests and e2e.
 */
import { rawDb } from "@/lib/db/raw";
import { runSeed } from "./seed/run";

const includeTestTenant = process.argv.includes("--with-test-tenant");

runSeed({ includeTestTenant })
  .then((workspaces) => {
    console.log(`seed: ${workspaces.map((w) => `${w.name} (${w.slug})`).join(", ")} ready`);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => rawDb.$disconnect());
