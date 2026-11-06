/**
 * `pnpm exec tsx --env-file=.env scripts/perf-scale.ts --workspace scale-test [--as-of YYYY-MM-DD]`
 * (M12 B3, measurement tooling, no product code path). Runs one nightly pass for a workspace
 * through the real queue (like jobs-nightly) and prints wall time per phase: kickoff, evaluate
 * chunks, score chunks (job processedOn/finishedOn), then today rebuild, outcome checkpoints and
 * the weekly digest, each timed in-process. Timings are for THIS machine, never staging.
 */
import { QueueEvents, Worker } from "bullmq";
import { businessClock } from "@/lib/dates";
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import { closeQueues, getQueue, queuePrefix, redisConnection } from "@/lib/jobs/queues";
import {
  evaluateLongCheckpoints,
  evaluateRevenueCheckpoints,
  evaluateSevenDayCheckpoints,
} from "@/modules/outcomes/service";
import { runWeeklyDigest } from "@/modules/reports/service";
import { rebuildWorkspaceToday } from "@/modules/today/service";
import { processorFor } from "@/worker/processors";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const ms = (n: number) => `${(n / 1000).toFixed(1)} s`;

async function timed<T>(label: string, fn: () => Promise<T>, out: string[]): Promise<T> {
  const t = Date.now();
  const r = await fn();
  out.push(`${label.padEnd(34)} ${ms(Date.now() - t)}`);
  return r;
}

async function main() {
  const slug = arg("workspace") ?? "scale-test";
  const ws = await findWorkspaceBySlug(slug);
  if (!ws) throw new Error(`No workspace ${slug}`);
  const out: string[] = [];
  const opts = { connection: redisConnection(), prefix: queuePrefix() };
  const workers = (["signals", "health"] as const).map(
    (q) => new Worker(q, processorFor(q)!, { ...opts, concurrency: 2 }),
  );
  const ev = { signals: new QueueEvents("signals", opts), health: new QueueEvents("health", opts) };
  await Promise.all(Object.values(ev).map((e) => e.waitUntilReady()));
  const t0 = Date.now();
  try {
    const runId = `perf-${t0}`;
    const kick = await getQueue("signals").add(
      "nightly.kickoff",
      { workspaceId: ws.id, runId, ...(arg("as-of") ? { asOf: arg("as-of") } : {}) },
      { jobId: `${ws.id}.kickoff.${runId}` },
    );
    const k = (await kick.waitUntilFinished(ev.signals, 600_000)) as {
      asOf: string;
      chunks: number;
      accounts: number;
    };
    const tKick = Date.now() - t0;
    const evalMs: number[] = [];
    const scoreMs: number[] = [];
    for (let c = 0; c < k.chunks; c++) {
      const e = await getQueue("signals").getJob(`${ws.id}.evaluate.${k.asOf}.${runId}.${c}`);
      await e!.waitUntilFinished(ev.signals, 1_800_000);
      let s = await getQueue("health").getJob(`${ws.id}.score.${k.asOf}.${runId}.${c}`);
      for (let i = 0; !s && i < 100; i++) {
        await new Promise((r) => setTimeout(r, 100));
        s = await getQueue("health").getJob(`${ws.id}.score.${k.asOf}.${runId}.${c}`);
      }
      await s!.waitUntilFinished(ev.health, 1_800_000);
      const e2 = (await getQueue("signals").getJob(e!.id!))!;
      evalMs.push(e2.finishedOn! - e2.processedOn!);
      const s2 = (await getQueue("health").getJob(s!.id!))!;
      scoreMs.push(s2.finishedOn! - s2.processedOn!);
    }
    const wall = Date.now() - t0;
    out.push(`accounts ${k.accounts}, chunks ${k.chunks}, as of ${k.asOf}`);
    out.push(`${"kickoff job".padEnd(34)} ${ms(tKick)}`);
    out.push(
      `${"evaluate chunks (signals)".padEnd(34)} sum ${ms(evalMs.reduce((a, b) => a + b, 0))}, max ${ms(Math.max(...evalMs))}, each ${evalMs.map((x) => (x / 1000).toFixed(1)).join("/")} s`,
    );
    out.push(
      `${"score chunks (health+renewals+..)".padEnd(34)} sum ${ms(scoreMs.reduce((a, b) => a + b, 0))}, max ${ms(Math.max(...scoreMs))}, each ${scoreMs.map((x) => (x / 1000).toFixed(1)).join("/")} s`,
    );
    out.push(`${"signals+health phase wall".padEnd(34)} ${ms(wall)}`);
    const ctx = { workspaceId: ws.id };
    await timed("today rebuild", () => rebuildWorkspaceToday(ctx), out);
    await timed("outcomes: 7-day checkpoints", () => evaluateSevenDayCheckpoints(ctx), out);
    await timed("outcomes: revenue checkpoints", () => evaluateRevenueCheckpoints(ctx), out);
    await timed(
      "outcomes: 30/90-day checkpoints",
      () => evaluateLongCheckpoints({ workspaceId: ws.id, timezone: ws.timezone }),
      out,
    );
    await timed(
      "reports.weeklyDigest",
      () => runWeeklyDigest({ workspaceId: ws.id, timezone: ws.timezone }, businessClock),
      out,
    );
    out.push(`${"TOTAL (all phases)".padEnd(34)} ${ms(Date.now() - t0)}`);
  } finally {
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(Object.values(ev).map((e) => e.close()));
    await closeQueues();
  }
  console.log(out.join("\n"));
}
main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e instanceof Error ? e.stack : e);
    process.exit(1);
  },
);
