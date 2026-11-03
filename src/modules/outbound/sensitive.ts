import type { ExtractionKind } from "@prisma/client";

/**
 * Sensitive-topic detection (ARCHITECTURE §7.4 guard 6, CLAUDE.md Rule 3). A conservative OR of
 * three inputs: this keyword list over the triggering text and the draft, sensitive extractions,
 * and sensitive step tags. Any hit caps the approval at DRAFT_FOR_APPROVAL, which no setting can
 * lift (DB CHECK approval_sensitive_cap). Conservative by design: over-flagging costs a review.
 * The list lives here, in code, so a change is reviewed and versioned like any other rule.
 */
export const SENSITIVE_REASONS = [
  "cancellation",
  "pricing",
  "legal",
  "security",
  "complaint",
  "escalation",
] as const;
export type SensitiveReason = (typeof SENSITIVE_REASONS)[number];

const KEYWORDS: Record<SensitiveReason, RegExp> = {
  cancellation:
    /\b(cancel(s|led|ling|lation)?|terminat(e|es|ed|ing|ion)|not renew(ing)?|won'?t renew|end (our|the) (contract|subscription)|churn(ing)?|switch(ing)? (to|providers?))\b/i,
  pricing:
    /\b(price[sd]?|pricing|discount(s|ed)?|refund(s|ed)?|cost(s)?|rate increase|overcharg(e|ed)|credit note|cheaper)\b/i,
  legal:
    /\b(legal|lawyers?|attorneys?|counsel|lawsuit|sue|liabilit(y|ies)|indemnif(y|ication)|contract terms|breach of contract|dpa)\b/i,
  security:
    /\b(security|breach(es|ed)?|hack(ed|ing)?|vulnerabilit(y|ies)|gdpr|data protection|personal data|incident|phishing|soc ?2)\b/i,
  complaint:
    /\b(complain(t|ts|ed|ing)?|unacceptable|disappointed|frustrat(ed|ing)|terrible|worst)\b/i,
  escalation:
    /\b(escalat(e|ed|es|ing|ion)|your (manager|ceo|vp)|speak to (a|your) (manager|supervisor))\b/i,
};

const EXTRACTION_REASON: Partial<Record<ExtractionKind, SensitiveReason>> = {
  CANCEL_LANGUAGE: "cancellation",
  EXPORT_LANGUAGE: "cancellation",
  COMPLAINT: "complaint",
};

export interface SensitiveInput {
  /** The triggering inbound text and the draft (subject + body). */
  texts: string[];
  extractions?: Array<{ kind: ExtractionKind; payload?: unknown }>;
  stepTags?: string[];
}

export interface SensitiveResult {
  isSensitive: boolean;
  reasons: SensitiveReason[];
  /** The words that matched, for the reviewer ("cancel" in the ticket). */
  matches: string[];
}

const isReason = (s: unknown): s is SensitiveReason =>
  typeof s === "string" && (SENSITIVE_REASONS as readonly string[]).includes(s);

export function detectSensitive(input: SensitiveInput): SensitiveResult {
  const found = new Set<SensitiveReason>();
  const matches: string[] = [];
  for (const reason of SENSITIVE_REASONS)
    for (const text of input.texts) {
      const m = text.match(KEYWORDS[reason]);
      if (m) {
        found.add(reason);
        matches.push(m[0]);
        break;
      }
    }
  for (const x of input.extractions ?? []) {
    const fromKind = EXTRACTION_REASON[x.kind];
    if (fromKind) found.add(fromKind);
    if (x.kind === "INTENT") {
      const intent = (x.payload as { intent?: unknown } | undefined)?.intent;
      if (isReason(intent)) found.add(intent);
    }
  }
  for (const tag of input.stepTags ?? []) if (isReason(tag)) found.add(tag);
  const reasons = SENSITIVE_REASONS.filter((r) => found.has(r));
  return { isSensitive: reasons.length > 0, reasons, matches };
}
