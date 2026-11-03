import type { AnyAgentDef } from "./define";
import type { BaseAgentOutput, ContextBundle } from "./schemas";
import { applyForbiddenNumeric, checkCitations, checkNumbers, citedRecords } from "./validate";

/**
 * Model output → what may be stored (ARCHITECTURE §1.3 step 6). Pure, shared by the executor and
 * the golden replay tests, so a recorded fixture is judged exactly as a live run would be.
 */
export type Evaluation =
  | { status: "SUCCEEDED"; output: BaseAgentOutput }
  | { status: "INVALID_OUTPUT" | "UNCITED"; problems: string[] };

export function evaluateOutput(
  def: AnyAgentDef,
  bundle: ContextBundle,
  raw: unknown,
  facts: Record<string, number> = {},
): Evaluation {
  const parsed = def.outputSchema.safeParse(raw);
  if (!parsed.success)
    return {
      status: "INVALID_OUTPUT",
      problems: parsed.error.issues.map((i) => `${i.path.join(".") || "output"}: ${i.message}`),
    };
  const output = parsed.data;
  const extra = def.extraCitations?.(output) ?? [];
  const problems = [...checkCitations(output.citations, bundle), ...checkCitations(extra, bundle)];
  const cited = citedRecords([...output.citations, ...extra], bundle);
  problems.push(...checkNumbers(def.narrative?.(output) ?? [], cited));
  if (problems.length) return { status: "UNCITED", problems };
  return {
    status: "SUCCEEDED",
    output: {
      ...output,
      proposedActions: applyForbiddenNumeric(
        output.proposedActions,
        def.forbiddenNumericFields,
        facts,
      ),
    },
  };
}
