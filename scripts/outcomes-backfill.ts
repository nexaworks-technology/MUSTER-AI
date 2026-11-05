/**
 * M11 (D-166): evaluate every due outcome checkpoint for one workspace now — the 7-day checkpoint,
 * the M7 revenue status and the frozen 30/90-day checkpoints — through the same functions the
 * `outcomes.checkpoint` job runs. Safe to re-run: stored checkpoints are never evaluated again.
 *
 *   pnpm outcomes:backfill --workspace <slug>
 */
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import {
  evaluateLongCheckpoints,
  evaluateRevenueCheckpoints,
  evaluateSevenDayCheckpoints,
} from "@/modules/outcomes/service";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg("workspace");
  if (!slug) throw new Error("usage: pnpm outcomes:backfill --workspace <slug>");
  const ws = await findWorkspaceBySlug(slug);
  if (!ws) throw new Error(`No workspace with slug "${slug}"`);
  const ctx = { workspaceId: ws.id };
  const d7 = await evaluateSevenDayCheckpoints(ctx);
  const revenue = await evaluateRevenueCheckpoints(ctx);
  const long = await evaluateLongCheckpoints({ ...ctx, timezone: ws.timezone });
  console.log(`${ws.name} (${slug})`);
  console.log(`  day 7:        ${d7.evaluated} evaluated ${JSON.stringify(d7.counts)}`);
  console.log(`  revenue:      ${revenue.evaluated} in window, ${revenue.changed} changed`);
  console.log(`  day 30 / 90:  ${long.evaluated} stored ${JSON.stringify(long.counts)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
