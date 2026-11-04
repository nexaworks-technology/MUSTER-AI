/**
 * `AI_PROVIDER=recorded AI_RECORDINGS_DIR=.dev-recordings/<name> pnpm exec tsx scripts/recorded-renewals.ts --workspace <slug> [--nonce <n>]`
 *
 * RECORDED-TRANSPORT FIXTURE (e2e and demo replay only; refused in production). No live model is
 * called. For Northgate Freight's renewal and Copperleaf Studios' expansion opportunity this composes
 * each "model answer" by fixed rules from the same records the agent is given (the Renewal Manager
 * writes its plan with {{metric.key}} placeholders and no digit; the Expansion Finder repeats the
 * usage and limit figures its cited signal states and leaves the estimate to the placeholder),
 * writes it as a recording keyed by the exact request a real run sends (prepareRun), then runs the
 * agents through the real executor: the same validation, citation and number checks, audit and
 * Approvals as a live run. When ANTHROPIC_API_KEY is set, run the agents live instead; this file is a
 * stand-in.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/config/env";
import { recordingKey } from "@/lib/ai/recorded";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import {
  expansionFinder,
  prepareRun,
  renewalManager,
  runAgent,
  type AnyAgentDef,
  type ContextBundle,
} from "@/modules/agents/service";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DIR = () => path.resolve(env().AI_RECORDINGS_DIR!);
const NONCE = () => arg("nonce") ?? "recorded-renewals";
const first = (name: string) => name.split(" ")[0] ?? name;

async function record(
  ctx: TenantContext,
  def: AnyAgentDef,
  input: unknown,
  answer: (bundle: ContextBundle, vars: Record<string, string>) => unknown,
) {
  const prep = await prepareRun(ctx, def, input);
  const file = path.join(DIR(), def.prompt.name, `${recordingKey(prep.request)}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(answer(prep.built.bundle, prep.built.vars), null, 2));
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
    "AI transport: RECORDED. Fixture answers composed from the records by scripts/recorded-renewals.ts; no live model is called.",
  );
  const results: string[] = [];

  // 1. Renewal Manager: Northgate Freight's open renewal.
  const northgate = await db.account.findFirstOrThrow({ where: { name: "Northgate Freight" } });
  const renewal = await db.renewal.findFirstOrThrow({
    where: { accountId: northgate.id, stage: { in: ["UPCOMING", "IN_PROGRESS"] } },
  });
  const rmInput = { renewalId: renewal.id };
  await record(ctx, renewalManager, rmInput, (bundle, vars) => {
    const rec = (t: string) => bundle.find((r) => r.sourceType === t);
    const renewalRec = rec("Renewal")!;
    const risks = bundle.filter((r) => r.sourceType === "Signal");
    const goals = bundle.filter((r) => r.sourceType === "Goal");
    const contact = rec("Contact");
    const hasNotice = renewalRec.fields.noticeDeadline !== null;
    return {
      reasoningSummary: risks.length
        ? "The renewal is close and the records show open risks to settle before the renewal call."
        : "The renewal is close and the records show no open risks; the plan focuses on the renewal conversation.",
      confidence: 0.7,
      citations: [
        { sourceType: "Renewal", sourceId: renewalRec.sourceId },
        ...risks.slice(0, 2).map((s) => ({ sourceType: "Signal", sourceId: s.sourceId })),
        ...(contact ? [{ sourceType: "Contact", sourceId: contact.sourceId }] : []),
      ],
      proposedActions: [],
      planSteps: [
        ...(risks.length
          ? [
              {
                title: "Review the open risks with the account team",
                detail: "The most serious is {{metric.risks.top}}.",
              },
            ]
          : []),
        ...(hasNotice
          ? [
              {
                title: "Hold the renewal call before the notice deadline",
                detail: "The notice deadline is {{metric.renewal.noticeDeadline}}.",
              },
            ]
          : []),
        { title: "Agree what the renewal needs to cover with the account owner", detail: null },
      ],
      talkTrack: [
        "Open with what the account uses most and what that has done for them.",
        ...(goals.length ? ["Review progress on their goals: {{metric.goals.status}}."] : []),
        "Ask what would make the renewal on {{metric.renewal.date}} an easy yes.",
      ],
      outreach: contact
        ? {
            subject: "Planning your renewal",
            body: `Hi ${first(String(contact.fields.name))},\n\nYour renewal comes up on {{metric.renewal.date}}. Could we find half an hour to look at how things are going and what you would like from the next year?\n\n${vars.csmName}`,
          }
        : { subject: null, body: null },
      nextStep: { action: "Confirm the renewal call", timing: "within_a_week" },
    };
  });
  const rm = await runAgent(ctx, renewalManager, rmInput, {
    type: "brief",
    id: `${renewal.id}:${NONCE()}`,
  });
  results.push(`renewal-manager Northgate: ${rm.kind === "run" ? rm.status : rm.kind}`);

  // 2. Expansion Finder: Copperleaf Studios' open opportunity.
  const copper = await db.account.findFirstOrThrow({ where: { name: "Copperleaf Studios" } });
  const opp = await db.expansionOpportunity.findFirstOrThrow({
    where: { accountId: copper.id, status: { in: ["OPEN", "IN_PROGRESS"] } },
  });
  const efInput = { opportunityId: opp.id };
  await record(ctx, expansionFinder, efInput, (bundle, vars) => {
    const signals = bundle.filter((r) => r.sourceType === "Signal");
    const seats = signals.find((s) => s.fields.rule === "seats_near_limit");
    const contract = bundle.find((r) => r.sourceType === "Contract");
    const usage = bundle.find((r) => r.sourceType === "UsageDaily");
    const contact = bundle.find((r) => r.sourceType === "Contact");
    if (!seats)
      return {
        reasoningSummary: "No limit-hit signal supports an expansion conversation.",
        confidence: 0.4,
        citations: [{ sourceType: "ExpansionOpportunity", sourceId: opp.id }],
        insufficientData: {
          missing: ["No usage or limit record shows the account is over a limit"],
        },
        proposedActions: [],
        narrative: null,
        conversation: { subject: null, body: null },
      };
    return {
      reasoningSummary:
        "More people use the product than the contract has seats for, and the records show newer people joining.",
      confidence: 0.8,
      citations: [
        { sourceType: "Signal", sourceId: seats.sourceId },
        ...(contract ? [{ sourceType: "Contract", sourceId: contract.sourceId }] : []),
        ...(usage ? [{ sourceType: "UsageDaily", sourceId: usage.sourceId }] : []),
      ],
      proposedActions: [],
      narrative: `${String(seats.fields.explanation)} That points to a team that has joined and may need more seats. Size: {{metric.expansion.estimate}}.`,
      conversation: contact
        ? {
            subject: "Your team's growth on Larkspur",
            body: `Hi ${first(String(contact.fields.name))},\n\nI noticed more people are using Larkspur than the seats on your plan, which is great to see. How are the plans for the team going, and would a short call to talk through the options be useful?\n\n${vars.csmName}`,
          }
        : { subject: null, body: null },
    };
  });
  const ef = await runAgent(ctx, expansionFinder, efInput, {
    type: "ask",
    id: `${opp.id}:${NONCE()}`,
  });
  results.push(`expansion-finder Copperleaf: ${ef.kind === "run" ? ef.status : ef.kind}`);
  for (const r of results) console.log(r);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
