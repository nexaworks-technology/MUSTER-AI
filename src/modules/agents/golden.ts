import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AnyAgentDef } from "./define";
import { evaluateOutput } from "./evaluate";
import type { ContextBundle } from "./schemas";

/**
 * Golden eval fixtures (M4 rule 6): known inputs → recorded model output → the expected verdict.
 * Replayed in CI by golden-replay.test.ts with no network; `pnpm eval` sends the same inputs to
 * the live model when ANTHROPIC_API_KEY is set. A fixture's `output` of `{ "__stopReason":
 * "refusal" }` stands for the model declining.
 */
export const GOLDEN_DIR = path.join(process.cwd(), "prompts", "__golden__");

export const goldenCase = z.object({
  case: z.string().min(1),
  description: z.string().min(1),
  agent: z.string().min(1),
  bundle: z.array(
    z.object({
      sourceType: z.string(),
      sourceId: z.string(),
      fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    }),
  ),
  facts: z.record(z.string(), z.number()).optional(),
  output: z.unknown(),
  expect: z.object({
    status: z.enum(["SUCCEEDED", "INVALID_OUTPUT", "UNCITED", "FAILED"]),
    items: z.number().int().min(0).optional(),
  }),
});
export type GoldenCase = z.infer<typeof goldenCase>;

export function loadGolden(agentDir: string): GoldenCase[] {
  const dir = path.join(GOLDEN_DIR, agentDir);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => goldenCase.parse(JSON.parse(readFileSync(path.join(dir, f), "utf8"))));
}

export type Verdict = {
  status: GoldenCase["expect"]["status"];
  items?: number;
  problems: string[];
};

/** Judges one output exactly as the executor would (same evaluateOutput, same refusal rule). */
export function judge(
  def: AnyAgentDef,
  bundle: ContextBundle,
  output: unknown,
  facts?: Record<string, number>,
): Verdict {
  if (
    output &&
    typeof output === "object" &&
    (output as { __stopReason?: string }).__stopReason === "refusal"
  )
    return { status: "FAILED", problems: ["MODEL_DECLINED"] };
  const e = evaluateOutput(def, bundle, output, facts);
  if (e.status !== "SUCCEEDED") return { status: e.status, problems: e.problems };
  // The Health Analyst's list is `items`; the Adoption Coach's is `findings`.
  const o = e.output as { items?: unknown[]; findings?: unknown[] };
  const items = o.items ?? o.findings;
  return {
    status: "SUCCEEDED",
    items: Array.isArray(items) ? items.length : undefined,
    problems: [],
  };
}
