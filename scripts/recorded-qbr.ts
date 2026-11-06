/**
 * `AI_PROVIDER=recorded AI_RECORDINGS_DIR=<dir> pnpm exec tsx --env-file=.env scripts/recorded-qbr.ts --workspace <slug> --account "<name>" [--period "Q3 2026"]`
 *
 * RECORDED-TRANSPORT FIXTURE for the QBR page (M12 Session C, C0a; same pattern as
 * scripts/leader-digest.ts; refused in production and without AI_PROVIDER=recorded). It prepares
 * the exact request `generateQbr` sends to the Meeting & QBR agent (`prepareRun`), composes an
 * answer from the very records the agent is given (it cites the account record, and states no
 * figure, since the locked metrics hold the numbers), and writes it as the recording keyed by that
 * request. When a person then generates the QBR in the app, the real executor judges this answer
 * with the same citation and number checks, audit and AgentRun as a live run. It creates nothing in
 * the database.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const { env } = await import("@/lib/config/env");
  const e = env();
  if (e.NODE_ENV === "production") throw new Error("This fixture script is refused in production");
  if (e.AI_PROVIDER !== "recorded" || !e.AI_RECORDINGS_DIR)
    throw new Error("Set AI_PROVIDER=recorded and AI_RECORDINGS_DIR (the app server's directory)");
  const { recordingKey } = await import("@/lib/ai/recorded");
  const { findWorkspaceBySlug } = await import("@/lib/db/workspace");
  const { scopedDb } = await import("@/lib/db/scoped");
  const { getAgent, prepareRun } = await import("@/modules/agents/service");

  const slug = arg("workspace");
  const name = arg("account");
  const period = arg("period") ?? "Q3 2026";
  if (!slug || !name) throw new Error('usage: … --workspace <slug> --account "<name>"');
  const ws = await findWorkspaceBySlug(slug);
  if (!ws) throw new Error(`No workspace with slug "${slug}"`);
  const ctx = { workspaceId: ws.id };
  const account = await scopedDb(ctx).account.findFirstOrThrow({
    where: { name },
    select: { id: true, name: true },
  });

  // The exact input generateQbr gives the agent (src/modules/qbr/service.ts).
  const prep = await prepareRun(ctx, getAgent("meeting-qbr")!, {
    action: "QBR_NARRATIVE",
    accountId: account.id,
    qbrPeriod: period,
  });
  const cited = prep.built.bundle.find(
    (r) => r.sourceType === "Account" && r.sourceId === account.id,
  );
  if (!cited) throw new Error(`The agent was not given ${account.name}'s account record`);
  const answer = {
    reasoningSummary: "Wrote the review narrative from the account record it was given.",
    confidence: 0.7,
    citations: [{ sourceType: cited.sourceType, sourceId: cited.sourceId }],
    proposedActions: [],
    title: `${account.name} executive business review`,
    summary: `A review of ${account.name} for the period, drawn from its account record. The figures are in the locked metrics.`,
    decisions: ["Keep the current plan and review adoption together at the next meeting."],
    actionItems: [{ title: "Agree the goals for the next period", description: "" }],
  };
  const dir = path.resolve(e.AI_RECORDINGS_DIR);
  const file = path.join(dir, prep.prompt.name, `${recordingKey(prep.request)}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(answer, null, 2));
  console.log(`recorded QBR narrative for ${account.name} (${period})`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
