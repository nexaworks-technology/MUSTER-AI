/**
 * `pnpm eval` — live evaluation of the M4 agents against their golden fixtures (outside the gate).
 *
 * Sends each fixture's input records to the live model (ANTHROPIC_API_KEY + AI_MODEL_* from env)
 * and judges the answer with the same validators as production. Adversarial fixtures stand for
 * model mistakes, so live runs are scored on the non-adversarial cases: the answer must be valid,
 * cited and, for "no claim" cases, make no claim. Without a key it prints DEFERRED and calls
 * nothing; the recorded fixtures still replay in CI (`pnpm test`).
 */
import { env } from "@/lib/config/env";
import { getAiProvider, loadPrompt, renderPrompt } from "@/lib/ai";
import { getAgent, judge, loadGolden } from "@/modules/agents/service";
import type { ContextBundle } from "@/modules/agents/service";
import { DEFAULT_THEMES } from "@/modules/conversations/service";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

async function main() {
  const e = env();
  if (!e.ANTHROPIC_API_KEY || e.AI_PROVIDER === "recorded") {
    console.log(
      "pnpm eval: DEFERRED — ANTHROPIC_API_KEY is not set (or AI_PROVIDER=recorded), so no live model was called. The golden fixtures replay in CI with `pnpm test`.",
    );
    return;
  }
  const provider = getAiProvider();
  const cases: Array<{
    agent: string;
    name: string;
    bundle: ContextBundle;
    expectStatus: string;
    expectItems?: number;
  }> = [];
  for (const c of loadGolden("health-analyst"))
    if (!c.description.startsWith("ADVERSARIAL") && c.expect.status === "SUCCEEDED")
      cases.push({
        agent: c.agent,
        name: c.case,
        bundle: c.bundle,
        expectStatus: "SUCCEEDED",
        expectItems: c.case.includes("no-claim") ? 0 : undefined,
      });
  const exDir = path.join(process.cwd(), "prompts", "__golden__", "extraction");
  for (const f of readdirSync(exDir).filter((x) => x.endsWith(".json"))) {
    const c = JSON.parse(readFileSync(path.join(exDir, f), "utf8"));
    if (!c.description.startsWith("ADVERSARIAL") && c.expect.status === "SUCCEEDED")
      cases.push({
        agent: "watcher",
        name: c.case,
        bundle: [
          { sourceType: "Message", sourceId: "src", fields: { subject: null, text: c.sourceText } },
        ],
        expectStatus: "SUCCEEDED",
      });
  }
  let passed = 0;
  for (const c of cases) {
    const def = getAgent(c.agent);
    const prompt = await loadPrompt(def.prompt.name, def.prompt.version);
    const r = await provider.generateStructured({
      tier: def.modelTier,
      workspaceId: "eval",
      promptRef: prompt.ref,
      system: renderPrompt(prompt.body, { accountName: "the account", themes: DEFAULT_THEMES.join(", ") }),
      input: JSON.stringify(c.bundle, null, 2),
      schema: def.outputSchema,
    });
    const v =
      r.output === null
        ? {
            status: r.stopReason === "refusal" ? "FAILED" : "INVALID_OUTPUT",
            items: undefined,
            problems: [],
          }
        : judge(def, c.bundle, r.output);
    const ok =
      v.status === c.expectStatus && (c.expectItems === undefined || v.items === c.expectItems);
    if (ok) passed++;
    console.log(
      `${ok ? "PASS" : "FAIL"} ${c.agent}/${c.name}: ${v.status}${v.problems.length ? ` (${v.problems.join("; ")})` : ""}`,
    );
  }
  console.log(`pnpm eval: ${passed}/${cases.length} live cases passed (model ids from env).`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
