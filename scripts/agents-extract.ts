/**
 * `pnpm agents:extract --workspace <slug> [--account "<name>"] [--limit N]`
 *
 * Watcher-basic backfill (M4): runs the extraction step over existing inbound messages and notes
 * that have no extraction for the current prompt version, then re-scores the touched accounts so
 * the Sentiment pillar sees the new labels. Says plainly which AI transport ran; with no key and
 * no recorded provider it stops at "AI is not configured" and writes nothing.
 */
import { env } from "@/lib/config/env";
import { scopedDb } from "@/lib/db/scoped";
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import { backfillExtractions } from "@/modules/agents/service";
import { recomputeAccounts } from "@/modules/health/service";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg("workspace");
  if (!slug)
    throw new Error(
      'usage: pnpm agents:extract --workspace <slug> [--account "<name>"] [--limit N]',
    );
  const ws = await findWorkspaceBySlug(slug);
  if (!ws) throw new Error(`No workspace with slug "${slug}"`);
  const ctx = { workspaceId: ws.id };
  const name = arg("account");
  const accountIds = name
    ? (await scopedDb(ctx).account.findMany({ where: { name }, select: { id: true } })).map(
        (a) => a.id,
      )
    : undefined;
  if (name && !accountIds?.length) throw new Error(`No account named "${name}"`);
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const e = env();
  console.log(
    `AI transport: ${e.AI_PROVIDER === "recorded" ? "RECORDED (fixture responses; no live model is called)" : e.ANTHROPIC_API_KEY ? "live Anthropic API" : "none configured"}`,
  );
  const r = await backfillExtractions(ctx, { accountIds, limit });
  if (r.notConfigured) {
    console.log(`AI is not configured (${r.reason}). Nothing was extracted or written.`);
    return;
  }
  console.log(`extraction: ${r.sources} source(s) run: ${JSON.stringify(r.counts)}`);
  const touched =
    accountIds ??
    (
      await scopedDb(ctx).account.findMany({
        where: { lifecycleStage: { not: "LOST" } },
        select: { id: true },
      })
    ).map((a) => a.id);
  await recomputeAccounts(ctx, touched);
  console.log(`re-scored ${touched.length} account(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
