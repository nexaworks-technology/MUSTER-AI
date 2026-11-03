/**
 * `AI_PROVIDER=recorded AI_RECORDINGS_DIR=.dev-recordings/<name> pnpm exec tsx scripts/recorded-onboarding.ts --workspace <slug>`
 *
 * RECORDED-TRANSPORT FIXTURE (e2e and demo replay only; refused in production). No live model is
 * called. For Pinecrest Health this composes each "model answer" by fixed rules from the same
 * records the agent is given (the Onboarding Manager names the overdue customer step and repeats its
 * own figures; the Adoption Coach names the plan features never used), writes it as a recording
 * keyed by the exact request a real run sends (prepareRun), then runs the agents through the real
 * paths: the `onboarding.stalled` consumer (owner notice, then the Onboarding Manager) and the
 * Adoption Coach. The same validation, citation and number checks, audit and Approvals as a live
 * run. When ANTHROPIC_API_KEY is set, run the agents live instead; this file is a stand-in.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/config/env";
import { recordingKey } from "@/lib/ai/recorded";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import {
  adoptionCoach,
  onboardingManager,
  prepareRun,
  runAgent,
  type AnyAgentDef,
  type ContextBundle,
} from "@/modules/agents/service";
import { onOnboardingStalled } from "@/modules/onboarding/service";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DIR = () => path.resolve(env().AI_RECORDINGS_DIR!);

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

/**
 * `--nonce` makes this run's agent triggers its own (default: one fixed set), so the e2e can draft
 * a fresh pending approval on every run while a plain re-run of the demo reuses the first one.
 */
const NONCE = () => arg("nonce") ?? "recorded-onboarding";

const first = (name: string) => name.split(" ")[0] ?? name;

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
    "AI transport: RECORDED. Fixture answers composed from the records by scripts/recorded-onboarding.ts; no live model is called.",
  );
  const results: string[] = [];
  const pinecrest = await db.account.findFirstOrThrow({ where: { name: "Pinecrest Health" } });
  const plan = await db.onboardingPlan.findFirstOrThrow({
    where: { accountId: pinecrest.id, status: { in: ["ACTIVE", "STALLED"] } },
  });

  // 1. Onboarding Manager: the check-in about the overdue customer step.
  await record(ctx, onboardingManager, { planId: plan.id, reason: "stalled" }, (bundle, vars) => {
    const rec = (t: string) => bundle.find((r) => r.sourceType === t);
    const planRec = rec("OnboardingPlan");
    const step = bundle.find(
      (r) =>
        r.sourceType === "OnboardingStep" &&
        r.fields.ownerSide === "customer" &&
        r.fields.daysOverdue,
    );
    const contact = rec("Contact");
    if (!planRec || !step || !contact)
      return {
        reasoningSummary: "There is no overdue customer step or contact to write about.",
        confidence: 0.5,
        citations: planRec ? [{ sourceType: "OnboardingPlan", sourceId: planRec.sourceId }] : [],
        insufficientData: { missing: ["No overdue customer step with a contact on file"] },
        proposedActions: [],
        subject: null,
        body: null,
        escalation: { needed: false, note: null },
      };
    const usage = bundle.filter((r) => r.sourceType === "UsageDaily");
    return {
      reasoningSummary: `The likely blocker is ${String(planRec.fields.likelyBlocker)}; the plan records no recent use of the product.`,
      confidence: 0.7,
      citations: [
        { sourceType: "OnboardingPlan", sourceId: planRec.sourceId },
        { sourceType: "OnboardingStep", sourceId: step.sourceId },
        { sourceType: "Contact", sourceId: contact.sourceId },
        ...usage.map((u) => ({ sourceType: "UsageDaily", sourceId: u.sourceId })),
      ],
      proposedActions: [],
      subject: `Getting ${String(step.fields.title)} done`,
      body: `Hi ${first(String(contact.fields.name))},\n\nThe ${String(step.fields.title)} step was due ${String(step.fields.dueDate)} and is ${String(step.fields.daysOverdue)} days overdue. Is something in the way? I can join a short call this week to help get it done.\n\n${vars.csmName}`,
      escalation: { needed: false, note: null },
    };
  });
  const stalled = await onOnboardingStalled({
    workspaceId: ws.id,
    accountId: pinecrest.id,
    planId: plan.id,
    outboxEventId: NONCE(),
  });
  results.push(
    `onboarding-manager Pinecrest: ${stalled.agent.kind === "run" ? stalled.agent.status : stalled.agent.kind} (owner notified: ${stalled.notified})`,
  );

  // 2. Adoption Coach: the finding about plan features never used, and one nudge.
  const input = { accountId: pinecrest.id, reason: "manual" as const };
  await record(ctx, adoptionCoach, input, (bundle, vars) => {
    const account = bundle.find((r) => r.sourceType === "Account")!;
    const catalog = bundle.filter((r) => r.sourceType === "FeatureCatalog");
    const used = bundle.find((r) => r.sourceType === "FeatureUsageDaily");
    const contact = bundle.find((r) => r.sourceType === "Contact");
    if (!catalog.length)
      return {
        reasoningSummary: "Every feature in the plan has been used.",
        confidence: 0.8,
        citations: [{ sourceType: "Account", sourceId: account.sourceId }],
        insufficientData: { missing: ["No unused feature to raise"] },
        proposedActions: [],
        findings: [],
        subject: null,
        body: null,
      };
    const lead = catalog.find((c) => c.fields.keyFeature === true) ?? catalog[0]!;
    const labels = catalog.map((c) => String(c.fields.feature)).join(", ");
    return {
      reasoningSummary: `${String(lead.fields.feature)} is in the plan and has never been used.`,
      confidence: 0.7,
      citations: [
        { sourceType: "Account", sourceId: account.sourceId },
        { sourceType: "FeatureCatalog", sourceId: lead.sourceId },
      ],
      proposedActions: [],
      findings: [
        {
          text: `${String(account.fields.summary)}: ${labels}.`,
          citesCatalogIds: catalog.map((c) => c.sourceId),
          citesUsageIds: used ? [used.sourceId] : [],
        },
      ],
      subject: `Getting more from ${String(lead.fields.feature)}`,
      body: contact
        ? `Hi ${first(String(contact.fields.name))},\n\n${String(account.fields.summary)}. ${String(lead.fields.feature)} could save your team time, and I'd be glad to walk you through setting it up.\n\n${vars.csmName}`
        : null,
    };
  });
  const coach = await runAgent(ctx, adoptionCoach, input, {
    type: "signal",
    id: NONCE(),
  });
  results.push(`adoption-coach Pinecrest: ${coach.kind === "run" ? coach.status : coach.kind}`);
  for (const r of results) console.log(r);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
