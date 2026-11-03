import { z } from "zod";

/**
 * The shapes every agent shares (ARCHITECTURE §6.1). Agents extend BaseAgentOutput; nothing an
 * agent returns reaches a screen or a customer until it passes validate.ts (Rules 1, 4, 5).
 */

/** A record the agent was given. `fields` hold the text it may quote and the numbers it may repeat. */
export interface ContextRecord {
  sourceType: string;
  sourceId: string;
  fields: Record<string, string | number | boolean | null>;
}
export type ContextBundle = ContextRecord[];

export const citationSchema = z.object({
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
  /** Optional verbatim quote from the cited record; checked as a substring. */
  quote: z.string().min(1).optional(),
});
export type Citation = z.infer<typeof citationSchema>;

/**
 * Something an agent suggests doing. `confidence` and `amountMinor` are never the model's to set:
 * the executor overwrites them from deterministic code (forbidden-numeric rule, §1.3 step 6c).
 */
export const proposedActionSchema = z.object({
  type: z.string().min(1),
  summary: z.string().min(1).max(500),
  confidence: z.number().optional(),
  amountMinor: z.number().optional(),
});
export type ProposedAction = z.infer<typeof proposedActionSchema>;

export const baseAgentOutput = z.object({
  reasoningSummary: z.string().min(1).max(1200),
  /** The model's own confidence, labelled as such in the UI ("model confidence"). */
  confidence: z.number().min(0).max(1),
  citations: z.array(citationSchema).min(1),
  /** What the agent could not find ("No contract on file"); it reports, never guesses. */
  insufficientData: z.object({ missing: z.array(z.string().min(1)) }).optional(),
  proposedActions: z.array(proposedActionSchema).default([]),
});
export type BaseAgentOutput = z.infer<typeof baseAgentOutput>;

/** Terminal statuses that render nothing (Rules 1, 4). */
export const NOT_RENDERED = ["INVALID_OUTPUT", "UNCITED", "FAILED", "SKIPPED"] as const;
