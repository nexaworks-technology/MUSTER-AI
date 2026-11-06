/**
 * `pnpm exec tsx --env-file=.env scripts/demo-purge-now.ts --workspace <slug>`
 *
 * DEV / E2E ONLY (M12 demo step 7). Refused wherever test seams are not allowed (production and
 * staging builds, D-182). For a workspace whose Admin has ALREADY requested deletion (typed
 * confirmation in Settings › Data), it ends the grace period now, as if the days had passed, and runs
 * the same purge as the hourly `maintenance.purgeWorkspaces` job. It never requests a deletion itself.
 */
import { testSeamsAllowed } from "@/lib/config/deployment";
import { env } from "@/lib/config/env";
import { endGraceNowForDemo } from "@/lib/db/deletion";
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import { purgeDueWorkspaces } from "@/modules/settings/service";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (env().NODE_ENV === "production" && !testSeamsAllowed())
    throw new Error("This demo script is refused in production");
  if (!testSeamsAllowed()) throw new Error("This demo script needs test seams (dev or e2e)");
  const slug = arg("workspace");
  if (!slug) throw new Error("usage: … --workspace <slug>");
  const ws = await findWorkspaceBySlug(slug);
  if (!ws) throw new Error(`No workspace with slug "${slug}"`);
  if (!(await endGraceNowForDemo(ws.id, new Date())))
    throw new Error(`"${slug}" has no open deletion request; an Admin must request it first`);
  const { purged } = await purgeDueWorkspaces(() => new Date());
  console.log(
    purged.includes(ws.id) ? `purged ${slug}` : `NOT purged ${slug} (see the worker log)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
