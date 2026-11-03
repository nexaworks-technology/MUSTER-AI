/**
 * `AI_PROVIDER=recorded AI_RECORDINGS_DIR=.dev-recordings/<name> pnpm exec tsx scripts/recorded-agents.ts --workspace <slug>`
 *
 * RECORDED-TRANSPORT FIXTURE (e2e and demo replay only; refused in production). No live model is
 * called. For a few story accounts this script composes each "model answer" by fixed rules from the
 * same records the agent is given (the Health Analyst repeats its two most negative reasons word
 * for word; Outreach quotes the signal's explanation; the Watcher labels by keyword), writes it as
 * a recording keyed by the exact request a real run sends (prepareRun), and then runs the agent
 * through the real executor: the same validation, citation and number checks, audit and approvals
 * as a live run. One Health Analyst answer is a recorded refusal, so a failed run exists to show.
 * When ANTHROPIC_API_KEY is set, run the agents live instead; this file is a stand-in, not a model.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/config/env";
import { recordingKey } from "@/lib/ai/recorded";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import { displayedSnapshot, getActiveModel } from "@/modules/health/service";
import {
  healthAnalyst,
  outreach,
  prepareRun,
  runAgent,
  watcher,
  type AnyAgentDef,
} from "@/modules/agents/service";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DIR = () => path.resolve(env().AI_RECORDINGS_DIR!);

async function record(
  ctx: TenantContext,
  def: AnyAgentDef,
  input: unknown,
  answer: (bundle: Awaited<ReturnType<typeof prepareRun>>["built"]["bundle"]) => unknown,
) {
  const prep = await prepareRun(ctx, def, input);
  const file = path.join(DIR(), def.prompt.name, `${recordingKey(prep.request)}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(answer(prep.built.bundle), null, 2));
}

const SNAPSHOT_WAIT_MS = 120_000;
const SNAPSHOT_POLL_MS = 1_000;

/**
 * The snapshot the account's Health tab shows (same lookup), waiting for it to exist. After a
 * model activation the re-score under the new active model runs on the worker, so the snapshot may
 * not be there yet. Polls up to 120 s, says so when it had to wait, and otherwise fails with a clear
 * setup error: it never dereferences a missing snapshot, and it never waits longer.
 */
async function waitForDisplayedSnapshot(
  ctx: TenantContext,
  accountId: string,
  accountName: string,
) {
  const started = Date.now();
  let polls = 0;
  for (;;) {
    const shown = await displayedSnapshot(ctx, accountId);
    if (shown) {
      if (polls > 0)
        console.log(
          `waited ${((Date.now() - started) / 1000).toFixed(1)} s for ${accountName}'s snapshot under the active health model (the post-activation re-score was still running)`,
        );
      return shown;
    }
    if (Date.now() - started >= SNAPSHOT_WAIT_MS) {
      const model = await getActiveModel(ctx);
      throw new Error(
        `Setup error: no health snapshot for ${accountName} under the active health model v${model.version} after waiting ${SNAPSHOT_WAIT_MS / 1000} s. The post-activation re-score did not complete in time (or never wrote one); check the worker.`,
      );
    }
    polls++;
    await new Promise((r) => setTimeout(r, SNAPSHOT_POLL_MS));
  }
}

async function main() {
  const e = env();
  if (e.AI_PROVIDER !== "recorded" || !e.AI_RECORDINGS_DIR)
    throw new Error(
      "Set AI_PROVIDER=recorded and AI_RECORDINGS_DIR: this script only drives the recorded transport.",
    );
  const slug = arg("workspace");
  if (!slug) throw new Error("usage: … --workspace <slug>");
  const ws = await findWorkspaceBySlug(slug);
  if (!ws) throw new Error(`No workspace with slug "${slug}"`);
  const ctx = { workspaceId: ws.id };
  const db = scopedDb(ctx);
  console.log(
    "AI transport: RECORDED. Fixture answers composed from the records by scripts/recorded-agents.ts; no live model is called.",
  );
  const results: string[] = [];
  const account = (name: string) =>
    db.account.findFirstOrThrow({ where: { name }, include: { owner: true } });

  // 1. Health Analyst for Brightwell: its two most negative evidence reasons, word for word.
  const bw = await account("Brightwell Logistics");
  // The snapshot Brightwell's Health tab shows (the narrative is about that one).
  const snap = await db.healthScoreSnapshot.findUniqueOrThrow({
    where: { id: (await waitForDisplayedSnapshot(ctx, bw.id, bw.name)).id },
    include: { reasons: true },
  });
  const top = snap.reasons
    .filter((r) => r.kind === "EVIDENCE" && Number(r.impact) < 0)
    .sort((a, b) => Number(a.impact) - Number(b.impact))
    .slice(0, 2);
  const haInput = { accountId: bw.id, snapshotId: snap.id };
  await record(ctx, healthAnalyst, haInput, () => ({
    reasoningSummary: top.length
      ? "The two reasons pulling the score down most, in the records' own words."
      : "Nothing in the reasons pulls the score down.",
    confidence: 0.7,
    citations: [
      { sourceType: "HealthScoreSnapshot", sourceId: snap.id },
      ...top.map((r) => ({ sourceType: "HealthReason", sourceId: r.id })),
    ],
    proposedActions: [],
    items: top.map((r) => ({ text: r.message, citesReasonIds: [r.id], citesSignalIds: [] })),
  }));
  const ha = await runAgent(ctx, healthAnalyst, haInput, { type: "snapshot", id: snap.id });
  results.push(`health-analyst Brightwell: ${ha.kind === "run" ? ha.status : ha.kind}`);

  // 2. A recorded refusal (Halden), so a failed run exists and is shown as failed.
  const halden = await account("Halden Retail");
  const haldenSnap = (await waitForDisplayedSnapshot(ctx, halden.id, halden.name)).id;
  const hInput = { accountId: halden.id, snapshotId: haldenSnap };
  await record(ctx, healthAnalyst, hInput, () => ({ __stopReason: "refusal" }));
  const hr = await runAgent(ctx, healthAnalyst, hInput, {
    type: "snapshot",
    id: haldenSnap,
  });
  results.push(
    `health-analyst Halden (recorded refusal): ${hr.kind === "run" ? hr.status : hr.kind}`,
  );

  // 3. Watcher on the planted customer messages: labels by keyword, quotes copied from the text.
  const planted = await db.message.findMany({
    where: {
      direction: "INBOUND",
      account: { name: { in: ["Quillmark Legal", "Halden Retail", "Marlow & Finch"] } },
    },
    select: { id: true, bodyText: true },
  });
  for (const m of planted) {
    const t = m.bodyText;
    const sentence = (re: RegExp) => t.split(/(?<=[.?!])\s+/).find((s) => re.test(s));
    await record(ctx, watcher, { sourceType: "MESSAGE", sourceId: m.id }, () => {
      const items = [];
      const cancel = sentence(/cancel/i);
      if (cancel)
        items.push({ kind: "CANCEL_LANGUAGE", quote: cancel, confidence: 0.9, payload: {} });
      const exp = sentence(/export/i);
      if (exp && /how do i export/i.test(exp))
        items.push({ kind: "EXPORT_LANGUAGE", quote: exp, confidence: 0.9, payload: {} });
      const complaint = sentence(/fail|losing patience|not loaded|blocking/i);
      if (complaint)
        items.push({
          kind: "COMPLAINT",
          quote: complaint,
          confidence: 0.8,
          payload: { theme: "product problem" },
        });
      const label = /losing patience|fail|cancel|blocking/i.test(t)
        ? "NEGATIVE"
        : /thank|smoother|great/i.test(t)
          ? "POSITIVE"
          : "NEUTRAL";
      const quote = complaint ?? cancel ?? sentence(/./) ?? t.slice(0, 40);
      return {
        reasoningSummary: "Labelled by keyword from the message text.",
        confidence: 0.6,
        citations: [{ sourceType: "Message", sourceId: m.id }],
        proposedActions: [],
        items,
        sentiment: { label, quote },
      };
    });
    const w = await runAgent(
      ctx,
      watcher,
      { sourceType: "MESSAGE", sourceId: m.id },
      { type: "extraction", id: `MESSAGE:${m.id}@${watcher.prompt.version}` },
    );
    results.push(`watcher ${m.id.slice(0, 8)}: ${w.kind === "run" ? w.status : w.kind}`);
  }

  // 4. Outreach: one AI check-in draft on Brightwell's usage-drop signal, into Approvals.
  const signal = await db.signal.findFirst({
    where: {
      accountId: bw.id,
      ruleKey: "usage_drop_vs_normal",
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
    },
  });
  const contact = await db.contact.findFirst({
    where: { accountId: bw.id, status: "ACTIVE", email: { not: null } },
    orderBy: { name: "asc" },
  });
  if (signal && contact && bw.ownerMembershipId) {
    const oInput = {
      sourceType: "Signal" as const,
      sourceId: signal.id,
      contactId: contact.id,
      requestedByMembershipId: bw.ownerMembershipId,
      nonce: "recorded-agents",
    };
    await record(ctx, outreach, oInput, () => ({
      reasoningSummary: "A short offer of help about the signal, quoting its explanation.",
      confidence: 0.6,
      citations: [
        { sourceType: "Signal", sourceId: signal.id },
        { sourceType: "Contact", sourceId: contact.id },
      ],
      proposedActions: [],
      subject: `Checking in: ${signal.title.toLowerCase()}`,
      body: `Hi ${contact.name.split(" ")[0]},\n\nI noticed this on our side: ${signal.explanation}\n\nIs anything getting in the way? Happy to set up a short walkthrough.\n\nBest regards`,
    }));
    const o = await runAgent(ctx, outreach, oInput, {
      type: "check-in",
      id: `Signal:${signal.id}:recorded-agents`,
    });
    results.push(`outreach Brightwell: ${o.kind === "run" ? o.status : o.kind}`);
  } else
    results.push(
      "outreach Brightwell: skipped (no open usage-drop signal or no reachable contact)",
    );

  for (const r of results) console.log(r);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
