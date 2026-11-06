/**
 * `pnpm db:seed:scale [--accounts 2000] [--workspace scale-test] [--reset]` (M12 B3). Seed
 * tooling only (Rule 6): synthetic rows in their own workspace. See prisma/seed/scale.ts.
 */
import { rawDb } from "@/lib/db/raw";
import { generateScale } from "./seed/scale";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const accounts = Number(arg("accounts") ?? 2000);
const slug = arg("workspace") ?? "scale-test";
if (!Number.isInteger(accounts) || accounts < 1 || accounts > 20_000) {
  console.error("--accounts must be an integer from 1 to 20000");
  process.exit(1);
}
generateScale({ accounts, slug, reset: process.argv.includes("--reset"), log: console.log })
  .then((r) => {
    console.log(
      `scale seed ${r.skipped ? "SKIPPED (workspace already has accounts; use --reset)" : "done"}: ${r.slug}, ${r.generationMs} ms (local, this machine)`,
    );
    console.log(JSON.stringify(r.counts));
  })
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => rawDb.$disconnect());
