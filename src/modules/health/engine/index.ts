import { createHash } from "node:crypto";
import { aggregate, type Aggregate, type ComponentResults } from "./aggregate";
import { COMPONENTS, runComponent } from "./components";
import { PILLARS, type ModelConfig } from "./model";
import type { AccountBundle } from "./types";

/**
 * The deterministic health engine: bundle in, score + reasons out. No I/O, no clock, no AI
 * (health-no-ai.test.ts). Code computes every number (ARCHITECTURE §4).
 */
export function scoreBundle(bundle: AccountBundle, model: ModelConfig): Aggregate {
  const results = Object.fromEntries(
    PILLARS.map((p) => [
      p,
      Object.fromEntries(
        Object.keys(COMPONENTS[p]).map((name) => [name, runComponent(p, name, bundle, model)]),
      ),
    ]),
  ) as ComponentResults;
  return aggregate(results, model, bundle.tier);
}

/** Stable JSON (sorted keys) so the same inputs always hash the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** Identifies the exact inputs + model a snapshot was computed from (skip identical re-runs). */
export function inputsHash(bundle: AccountBundle, modelId: string): string {
  return createHash("sha256").update(modelId).update(canonical(bundle)).digest("hex");
}

export type { Aggregate } from "./aggregate";
export type { AccountBundle } from "./types";
