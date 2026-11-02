/**
 * `pnpm jobs:nightly --workspace <slug> [--as-of YYYY-MM-DD]`
 *
 * Runs one nightly pass for a workspace THROUGH THE REAL QUEUE (M3 rule 9): enqueues
 * nightly.kickoff with a fresh run id, processes it with in-process workers for the signals and
 * health queues (a running `pnpm dev:worker` may take some of the jobs; that is fine), waits for
 * every chunk, and prints what changed. Re-running it is safe: the second pass changes nothing.
 */
import { QueueEvents, Worker } from "bullmq";
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import { closeQueues, getQueue, queuePrefix, redisConnection } from "@/lib/jobs/queues";
import { processorFor } from "@/worker/processors";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg("workspace");
  const asOf = arg("as-of");
  if (!slug) throw new Error("usage: pnpm jobs:nightly --workspace <slug> [--as-of YYYY-MM-DD]");
  const ws = await findWorkspaceBySlug(slug);
  if (!ws) throw new Error(`No workspace with slug "${slug}"`);

  const opts = { connection: redisConnection(), prefix: queuePrefix() };
  const workers = (["signals", "health"] as const).map(
    (q) => new Worker(q, processorFor(q)!, { ...opts, concurrency: 2 }),
  );
  const events = {
    signals: new QueueEvents("signals", opts),
    health: new QueueEvents("health", opts),
  };
  await Promise.all(Object.values(events).map((e) => e.waitUntilReady()));
  const started = Date.now();
  try {
    const runId = `cli-${started}`;
    const kick = await getQueue("signals").add(
      "nightly.kickoff",
      { workspaceId: ws.id, runId, ...(asOf ? { asOf } : {}) },
      { jobId: `${ws.id}.kickoff.${runId}` },
    );
    const k = (await kick.waitUntilFinished(events.signals, 120_000)) as {
      asOf: string;
      chunks: number;
      accounts: number;
    };
    const totals = {
      opened: 0,
      updated: 0,
      resolved: 0,
      suppressed: 0,
      CREATED: 0,
      REPLACED: 0,
      UNCHANGED: 0,
      bandChanges: 0,
    };
    for (let c = 0; c < k.chunks; c++) {
      const evaluate = await getQueue("signals").getJob(
        `${ws.id}.evaluate.${k.asOf}.${runId}.${c}`,
      );
      Object.entries(
        (await evaluate!.waitUntilFinished(events.signals, 600_000)) as Record<string, number>,
      ).forEach(([key, n]) => (totals[key as keyof typeof totals] += n));
      let score = await getQueue("health").getJob(`${ws.id}.score.${k.asOf}.${runId}.${c}`);
      for (let i = 0; !score && i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        score = await getQueue("health").getJob(`${ws.id}.score.${k.asOf}.${runId}.${c}`);
      }
      Object.entries(
        (await score!.waitUntilFinished(events.health, 600_000)) as Record<string, number>,
      ).forEach(([key, n]) => (totals[key as keyof typeof totals] += n));
    }
    console.log(
      `nightly ${slug} as of ${k.asOf}: ${k.accounts} accounts in ${k.chunks} chunk(s), ${Date.now() - started} ms\n` +
        `  signals: ${totals.opened} opened, ${totals.updated} updated, ${totals.resolved} resolved, ${totals.suppressed} kept quiet (false alarms)\n` +
        `  health:  ${totals.CREATED} new snapshots, ${totals.REPLACED} replaced, ${totals.UNCHANGED} unchanged, ${totals.bandChanges} band changes`,
    );
  } finally {
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(Object.values(events).map((e) => e.close()));
    await closeQueues();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
