import { describe, expect, it } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  M4_AGENTS,
  M6_AGENTS,
  M7_AGENTS,
  M8_AGENTS,
  M9_AGENTS,
  M10_AGENTS,
  M11_AGENTS,
} from "../definitions";

/**
 * The live provider rejects a structured-output JSON schema with an untyped node
 * ("JSON schema must have a type defined if anyOf/oneOf/allOf are not used"); the recorded
 * provider never sends a schema, so only this test catches it before production (DEMO FAIL 34/35).
 */
type Node = Record<string, unknown>;
const COMPOSITE = ["anyOf", "oneOf", "allOf"] as const;

function untypedPaths(node: unknown, path: string, out: string[]): void {
  if (!node || typeof node !== "object") return;
  const n = node as Node;
  const typed = "type" in n || "$ref" in n || "const" in n || "enum" in n;
  if (!typed && !COMPOSITE.some((k) => k in n)) out.push(path || "<root>");
  if (n.properties && typeof n.properties === "object")
    for (const [k, v] of Object.entries(n.properties as Node)) untypedPaths(v, `${path}.${k}`, out);
  if (n.items) untypedPaths(n.items, `${path}[]`, out);
  if (n.additionalProperties && typeof n.additionalProperties === "object")
    untypedPaths(n.additionalProperties, `${path}{}`, out);
  for (const k of COMPOSITE)
    if (Array.isArray(n[k]))
      (n[k] as unknown[]).forEach((v, i) => untypedPaths(v, `${path}|${k}${i}`, out));
  for (const defs of ["$defs", "definitions"])
    if (n[defs] && typeof n[defs] === "object")
      for (const [k, v] of Object.entries(n[defs] as Node)) untypedPaths(v, `#${k}`, out);
}

const AGENTS = [
  ...M4_AGENTS,
  ...M6_AGENTS,
  ...M7_AGENTS,
  ...M8_AGENTS,
  ...M9_AGENTS,
  ...M10_AGENTS,
  ...M11_AGENTS,
];

/**
 * Known, not fixed here: Play Builder's output reuses the play definition, which has `z.bigint()`
 * ARR bounds and untyped step params, so a live Play Builder call fails the same way. Recorded in
 * docs/QUESTIONS.md; this entry turns red the day it is fixed, so it cannot be forgotten.
 */
const KNOWN_DEFECTS = new Set(["play-builder"]);

describe("agent output schemas as the live provider receives them", () => {
  it.fails("play-builder (known defect, docs/QUESTIONS.md)", () => {
    const agent = AGENTS.find((a) => a.key === "play-builder")!;
    zodOutputFormat(agent.outputSchema);
  });

  const checked = AGENTS.filter((a) => !KNOWN_DEFECTS.has(a.key));
  it.each(checked.map((a) => [a.key, a] as const))("%s has a type on every node", (_key, agent) => {
    const { schema } = zodOutputFormat(agent.outputSchema);
    const out: string[] = [];
    untypedPaths(schema, "", out);
    expect(out).toEqual([]);
  });
});
