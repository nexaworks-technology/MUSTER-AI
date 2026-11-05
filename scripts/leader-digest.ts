/**
 * `AI_PROVIDER=recorded pnpm reports:digest --workspace <slug>`  (dev only)
 *
 * Runs this business week's leader digest for a workspace THROUGH THE REAL QUEUE (job
 * `reports.weeklyDigest`, dedupe id per workspace and week): stores the week's SCHEDULED report
 * snapshots, lets the Leader Reporter write the digest, and delivers it to the workspace's Admins
 * and CS Leaders (in-app, staff email through the log transport, Slack if connected). Running it
 * again in the same week changes nothing.
 *
 * RECORDED-TRANSPORT FIXTURE (same pattern as scripts/recorded-renewals.ts; refused in
 * production): with AI_PROVIDER=recorded no live model is called. The "model answer" is composed by
 * fixed rules from the very records the agent is given (one item per report, repeating only figures
 * and dates as the records state them), written as a recording keyed by the exact request a real run
 * sends (prepareRun), and then judged by the real executor: the same citation and number checks,
 * audit and AgentRun as a live run. With ANTHROPIC_API_KEY set and AI_PROVIDER unset the agent runs
 * live instead and nothing is recorded. With neither, leaders get the honest "not written" notice.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { QueueEvents, Worker } from "bullmq";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const UNIT_SUFFIX: Record<string, (v: number) => string> = {
  count: (v) => `${v}`,
  percent: (v) => `${v}%`,
  days: (v) => `${v} ${v === 1 ? "day" : "days"}`,
  hours: (v) => `${v} ${v === 1 ? "hour" : "hours"}`,
};

async function main() {
  // The recorded transport reads AI_RECORDINGS_DIR; default it for this script before env() is read.
  if (process.env.AI_PROVIDER === "recorded")
    process.env.AI_RECORDINGS_DIR ??= ".dev-recordings/leader-digest";
  const { env } = await import("@/lib/config/env");
  const { recordingKey } = await import("@/lib/ai/recorded");
  const { findWorkspaceBySlug } = await import("@/lib/db/workspace");
  const { closeQueues, getQueue, queuePrefix, redisConnection } = await import("@/lib/jobs/queues");
  const { weeklyDigestJobId } = await import("@/lib/jobs/ids");
  const { prepareRun, leaderReporter } = await import("@/modules/agents/service");
  const { ensureWeeklySnapshots } = await import("@/modules/reports/service");
  const { processorFor } = await import("@/worker/processors");
  const { businessClock } = await import("@/lib/dates");

  const slug = arg("workspace");
  if (!slug) throw new Error("usage: pnpm reports:digest --workspace <slug>");
  const ws = await findWorkspaceBySlug(slug);
  if (!ws) throw new Error(`No workspace with slug "${slug}"`);
  const e = env();
  const ctx = { workspaceId: ws.id, timezone: ws.timezone };

  const week = await ensureWeeklySnapshots(ctx, businessClock);
  if (!week)
    throw new Error("This workspace has no active Admin or CS Leader to send a digest to.");
  console.log(`week of ${week.weekStart}: ${week.snapshotIds.length} report snapshots stored`);

  if (e.AI_PROVIDER === "recorded") {
    console.log(
      "AI transport: RECORDED. The digest answer is composed from the records by scripts/leader-digest.ts; no live model is called.",
    );
    const prep = await prepareRun(ctx, leaderReporter, { snapshotIds: week.snapshotIds });
    const bundle = prep.built.bundle;
    const headers = bundle.filter((r) => !r.sourceId.includes("#"));
    const items = headers.map((h) => {
      const figures = bundle.filter(
        (r) => r.sourceId.startsWith(`${h.sourceId}#`) && typeof r.fields.unit === "string",
      );
      const valued = figures
        .filter((r) => typeof r.fields.value === "number" && String(r.fields.unit) in UNIT_SUFFIX)
        .slice(0, 2);
      const empty = figures.find((r) => r.fields.value === null);
      const title = String(h.fields.report).replaceAll("-", " ");
      const cited = [h, ...valued, ...(valued.length === 0 && empty ? [empty] : [])];
      const text = valued.length
        ? `The ${title} report for ${h.fields.periodStart} to ${h.fields.periodEnd}: ` +
          valued
            .map(
              (r) =>
                `${String(r.fields.label)} is ${UNIT_SUFFIX[String(r.fields.unit)]!(Number(r.fields.value))}`,
            )
            .join("; ") +
          "."
        : empty
          ? `The ${title} report for ${h.fields.periodStart} to ${h.fields.periodEnd} has no figure for ${String(empty.fields.label)}: ${String(empty.fields.reason)}`
          : `The ${title} report for ${h.fields.periodStart} to ${h.fields.periodEnd} has no figures this week.`;
      return {
        text,
        citations: cited.map((r) => ({ sourceType: r.sourceType, sourceId: r.sourceId })),
      };
    });
    const answer = {
      reasoningSummary: "One short item per report, repeating only what each figure states.",
      confidence: 0.7,
      citations: items.flatMap((i) => i.citations),
      proposedActions: [],
      items,
    };
    const dir = path.resolve(e.AI_RECORDINGS_DIR ?? ".dev-recordings/leader-digest");
    const file = path.join(dir, prep.prompt.name, `${recordingKey(prep.request)}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(answer, null, 2));
  } else if (e.ANTHROPIC_API_KEY) console.log("AI transport: LIVE (Anthropic).");
  else
    console.log("AI transport: none configured; leaders will get the honest 'not written' notice.");

  const opts = { connection: redisConnection(), prefix: queuePrefix() };
  const worker = new Worker("reports", processorFor("reports")!, opts);
  const events = new QueueEvents("reports", opts);
  await events.waitUntilReady();
  try {
    const job = await getQueue("reports").add(
      "reports.weeklyDigest",
      { workspaceId: ws.id },
      { jobId: weeklyDigestJobId(ws.id, week.weekStart) },
    );
    const result = (await job.waitUntilFinished(events, 120_000)) as Record<string, unknown>;
    console.log(`reports.weeklyDigest ${slug}: ${JSON.stringify(result)}`);
  } finally {
    await worker.close();
    await events.close();
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
