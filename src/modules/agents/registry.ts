import { loadPrompt } from "@/lib/ai";
import type { AnyAgentDef } from "./define";
import {
  M4_AGENTS,
  M6_AGENTS,
  M7_AGENTS,
  M8_AGENTS,
  M9_AGENTS,
  M10_AGENTS,
  M11_AGENTS,
} from "./definitions";

/**
 * Every agent the product runs (ARCHITECTURE §6.2). Only the spec's 13 agents + Ask AI may be
 * added (D-30). Definitions register themselves here as their milestone ships them.
 */
let registry: Map<string, AnyAgentDef> | null = null;
/**
 * Built on first use, not at import: definitions import module services that can import this
 * module back, so an eager map could read a definition before its module finished loading.
 */
function agents(): Map<string, AnyAgentDef> {
  registry ??= new Map<string, AnyAgentDef>(
    [
      ...M4_AGENTS,
      ...M6_AGENTS,
      ...M7_AGENTS,
      ...M8_AGENTS,
      ...M9_AGENTS,
      ...M10_AGENTS,
      ...M11_AGENTS,
    ].map((d) => [d.key, d]),
  );
  return registry;
}

export function registerAgent(def: AnyAgentDef): AnyAgentDef {
  const existing = agents().get(def.key);
  if (existing && existing !== def) throw new Error(`agent "${def.key}" is registered twice`);
  agents().set(def.key, def);
  return def;
}

export function getAgent(key: string): AnyAgentDef {
  const def = agents().get(key);
  if (!def) throw new Error(`unknown agent "${key}"`);
  return def;
}

export const listAgents = (): AnyAgentDef[] => [...agents().values()];

/**
 * Startup check (M4 §2): every registered agent's prompt file exists, and its frontmatter name,
 * version and agent key match the definition. Throws with every problem listed.
 */
export async function checkAgentPrompts(defs: AnyAgentDef[] = listAgents(), dir?: string) {
  const problems: string[] = [];
  for (const def of defs) {
    try {
      const p = await loadPrompt(def.prompt.name, def.prompt.version, dir);
      if (p.agent !== def.key)
        problems.push(`${p.ref}: frontmatter agent "${p.agent}" ≠ "${def.key}"`);
      if (p.tier !== def.modelTier)
        problems.push(`${p.ref}: tier "${p.tier}" ≠ "${def.modelTier}"`);
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (problems.length) throw new Error(`agent prompt check failed:\n- ${problems.join("\n- ")}`);
  return defs.length;
}
