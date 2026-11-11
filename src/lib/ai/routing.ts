import type { ModelTier } from "./types";

/**
 * Frugal model routing (docs/AI-COST-2026-11-11.md). Every AI job runs on the FAST tier
 * (AI_MODEL_FAST, claude-haiku-4-5) unless it is named here. This is the one list: moving a job to
 * a dearer tier means adding its key below, and `routing.test.ts` pins the whole table.
 *
 * A job key is an agent key (`watcher`, `health-analyst`, …) or, for the prompts one agent shares
 * (`meeting-brief`, `qbr-narrative`, `ask-ai-plan`), the prompt name.
 */
export const DEEP_TIER_JOBS: readonly string[] = [
  /** Ask AI's final, cited answer: multi-record reasoning the user reads directly. */
  "ask-ai",
  /** The weekly leader digest: one accurate summary leaders act on. */
  "leader-reporter",
];

/** The model tier a job runs on. Model names never appear here: a tier maps to env (AI_MODEL_*). */
export function jobTier(job: string): ModelTier {
  return DEEP_TIER_JOBS.includes(job) ? "deep" : "fast";
}
