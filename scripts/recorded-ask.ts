/**
 * M11 (demo + e2e, recorded transport): composes Ask AI's model answers for the demo questions by
 * fixed rules FROM THE RECORDS ITS TOOLS RETURN, writes them as recordings keyed by the exact
 * request, and lets the real loop + executor judge them (validation, numbers rule, AgentRun, audit
 * are all real). Same pattern as scripts/recorded-renewals.ts and the Leader Reporter. There is no
 * API key on this machine; a live model would decide these steps itself.
 *
 *   AI_PROVIDER=recorded AI_RECORDINGS_DIR=.dev-recordings/<name> \
 *     pnpm exec tsx --env-file=.env scripts/recorded-ask.ts --workspace <slug> [--as <email>]
 *
 * Asking the same question again in the app (same member, same data) replays these recordings.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import { recordingKey } from "@/lib/ai/recorded";
import { env } from "@/lib/config/env";
import { scopedDb } from "@/lib/db/scoped";
import { findWorkspaceBySlug } from "@/lib/db/workspace";
import { askQuestion, type AskActor } from "@/modules/ask-ai/service";
import { publishPlay } from "@/modules/plays/service";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

export const DEMO_QUESTIONS = [
  "Which accounts mentioned a competitor this month, and what did they say?",
  "What is Northgate Freight's contract value?",
  "What is Fairhaven Dental Group's contract value?",
  "Move Northgate Freight and Brightwell Logistics to the Renewal Risk play.",
];

type Rec = {
  ref: string;
  type: string;
  id: string;
  label: string;
  fields: Record<string, unknown>;
};
type Result = { tool: string; input: unknown; records: Rec[]; notFound: string | null };
type BundleRec = { sourceType: string; sourceId: string; fields: Record<string, unknown> };
const base = {
  reasoningSummary: "Answered from the records the tools returned.",
  confidence: 0.75,
  proposedActions: [],
};
const money = (v: string) => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

/** Planner: which tools to call for this question, from what earlier steps returned. */
function plan(question: string, step: number, results: Result[]) {
  const done = { action: "answer" as const, calls: [] };
  const names = [...question.replace(/^(Move|What is|Which)\s+/, "").matchAll(/([A-Z][\w&]+(?: [A-Z][\w&]+)+)/g)]
    .map((m) => m[1]!)
    .filter((n) => !/^(Which|What|Move|Renewal Risk)/.test(n));
  const accountIds = (name: string) =>
    results
      .flatMap((r) => r.records)
      .filter((r) => r.ref.startsWith("Account:") && r.label === name)
      .map((r) => r.ref.slice("Account:".length));
  if (/competitor/i.test(question))
    return step === 1
      ? {
          action: "call",
          calls: [{ tool: "searchConversations", input: { kinds: ["COMPETITOR"] } }],
        }
      : done;
  if (/contract value/i.test(question)) {
    if (step === 1)
      return {
        action: "call",
        calls: names.map((n) => ({ tool: "searchAccounts", input: { query: n } })),
      };
    if (step === 2) {
      const ids = names.flatMap(accountIds);
      return ids.length
        ? {
            action: "call",
            calls: ids.flatMap((id) => [
              { tool: "getContract", input: { accountId: id } },
              { tool: "getAccount360Summary", input: { accountId: id } },
            ]),
          }
        : done;
    }
    return done;
  }
  if (/play/i.test(question)) {
    if (step === 1)
      return {
        action: "call",
        calls: [
          { tool: "listPlays", input: {} },
          ...names.map((n) => ({ tool: "searchAccounts", input: { query: n } })),
        ],
      };
    return done;
  }
  return done;
}

/** Answer: composed only from the bundle the run was given. */
function answer(question: string, bundle: BundleRec[], notFound: string) {
  const of = (t: string) => bundle.filter((r) => r.sourceType === t);
  if (/competitor/i.test(question)) {
    const xs = of("Extraction");
    if (!xs.length) return null;
    return {
      ...base,
      answer: xs
        .map((x) => `${x.fields.accountName} — ${x.fields.label}: “${x.fields.quote}”`)
        .join("\n"),
      citations: xs.map((x) => ({
        sourceType: "Extraction",
        sourceId: x.sourceId,
        quote: String(x.fields.quote),
      })),
    };
  }
  if (/contract value/i.test(question)) {
    const account = of("Account")[0];
    if (!account) return null;
    const contract = of("Contract").find((c) => c.fields.current === true) ?? of("Contract")[0];
    // Say "cannot see" only when a tool reported it — never as a default.
    if (!contract && !/cannot see a contract/i.test(notFound)) return null;
    if (!contract)
      return {
        ...base,
        answer: `I cannot see a contract for ${account.fields.name}.`,
        citations: [{ sourceType: "Account", sourceId: account.sourceId }],
      };
    if (typeof contract.fields.value !== "string")
      return {
        ...base,
        answer: `I can see ${account.fields.name}'s contract, but its value is a revenue figure your role does not include.`,
        citations: [{ sourceType: "Contract", sourceId: contract.sourceId }],
      };
    return {
      ...base,
      answer: `${account.fields.name}'s contract is worth ${money(contract.fields.value)} ${contract.fields.valueCurrency}${contract.fields.renewal ? `, renewing on ${contract.fields.renewal}` : ""}.`,
      citations: [{ sourceType: "Contract", sourceId: contract.sourceId }],
      figures: [
        {
          value: String(contract.fields.value),
          sourceType: "Contract",
          sourceId: contract.sourceId,
          field: "value",
        },
      ],
    };
  }
  if (/play/i.test(question)) {
    const play = of("Play").find((p) => /renewal risk/i.test(String(p.fields.name)));
    const accounts = of("Account").filter((a) => question.includes(String(a.fields.name)));
    if (!play) {
      const any = of("Account")[0];
      return any
        ? {
            ...base,
            answer: `I cannot see a published Renewal Risk play, so I cannot prepare the enrolment.${notFound !== "(none)" ? "" : ""}`,
            citations: [{ sourceType: "Account", sourceId: any.sourceId }],
          }
        : null;
    }
    if (!accounts.length) return null;
    return {
      ...base,
      answer: `I prepared the enrolment in ${play.fields.name} for: ${accounts.map((a) => a.fields.name).join(", ")}. Nothing changes until it is approved.`,
      citations: [
        { sourceType: "Play", sourceId: play.sourceId },
        ...accounts.map((a) => ({ sourceType: "Account", sourceId: a.sourceId })),
      ],
      proposal: {
        reason: `Asked in Ask AI: ${question}`,
        items: accounts.map((a) => ({
          kind: "ENROLL_PLAY",
          accountId: a.sourceId,
          playId: play.sourceId,
        })),
      },
    };
  }
  return null;
}

function composer(dir: string, question: string): AiProvider {
  return {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      let output: unknown;
      if (req.promptRef.startsWith("ask-ai-plan@")) {
        const { step, results } = JSON.parse(req.input) as { step: number; results: Result[] };
        output = plan(question, step, results);
      } else {
        const bundle = JSON.parse(req.input.slice(req.input.indexOf("["))) as BundleRec[];
        const nf =
          /What the tools could not find[^\n]*\n([\s\S]*?)\n\nRules/.exec(req.system)?.[1] ??
          "(none)";
        output = answer(question, bundle, nf);
      }
      const file = path.join(dir, req.promptRef.split("@")[0]!, `${recordingKey(req)}.json`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(output, null, 2));
      const parsed = req.schema.safeParse(output);
      return {
        output: parsed.success ? parsed.data : null,
        stopReason: parsed.success ? "end_turn" : "invalid_output",
        model: "recorded",
        requestId: null,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
      };
    },
  };
}

async function main() {
  const e = env();
  if (e.NODE_ENV === "production") throw new Error("refused in production");
  if (e.AI_PROVIDER !== "recorded" || !e.AI_RECORDINGS_DIR)
    throw new Error(
      "Set AI_PROVIDER=recorded and AI_RECORDINGS_DIR: this script only drives the recorded transport.",
    );
  const slug = arg("workspace");
  if (!slug)
    throw new Error(
      "usage: … --workspace <slug> [--as <email>] [--publish-play <key>] [--question <q>]",
    );
  const ws = await findWorkspaceBySlug(slug);
  if (!ws) throw new Error(`No workspace with slug "${slug}"`);
  const db = scopedDb({ workspaceId: ws.id });
  const email = arg("as") ?? "dana@larkspur.test";
  const m = await db.membership.findFirstOrThrow({ where: { user: { email } } });
  const actor: AskActor = {
    workspaceId: ws.id,
    userId: m.userId,
    membershipId: m.id,
    role: m.role,
    canViewRevenue: m.canViewRevenue,
    bookScope: m.bookScope,
  };
  // Demo setup, labelled: a person (the --as member, a leader) publishes the play first, with no
  // retroactive enrolment — the same publishPlay the Plays screen calls. Seed resets it to DRAFT.
  const playKey = arg("publish-play");
  if (playKey) {
    const play = await db.play.findFirstOrThrow({ where: { key: playKey } });
    if (play.status !== "PUBLISHED") {
      const res = await publishPlay(actor, play.id, { retroactive: false });
      console.log(
        `[DEMO SETUP] ${email} published the play "${play.name}" (no retroactive enrolment): ${JSON.stringify(res).slice(0, 160)}`,
      );
    } else console.log(`[DEMO SETUP] the play "${play.name}" is already published`);
  }
  const dir = path.resolve(e.AI_RECORDINGS_DIR);
  for (const q of arg("question") ? [arg("question")!] : DEMO_QUESTIONS) {
    const res = await askQuestion(actor, { question: q }, { provider: composer(dir, q) });
    console.log(`ask-ai "${q}" as ${email}: ${res.status} (run ${res.runId ?? "-"})`);
  }
}

if (process.argv[1]?.endsWith("recorded-ask.ts"))
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
