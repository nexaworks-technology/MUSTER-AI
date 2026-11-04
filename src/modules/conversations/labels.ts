import type { ExtractionKind } from "@prisma/client";

/**
 * What an extraction reads as on screen (M9): a plain label, never a score. Every label is shown
 * with its verbatim quote beside it; this only words the label and picks its tone.
 */
export type LabelTone = "good" | "neutral" | "risk" | "negative" | "mixed";
export interface DisplayLabel {
  kind: ExtractionKind;
  text: string;
  tone: LabelTone;
}

/** Kinds that make a customer message sensitive (it always goes to a person). */
export const SENSITIVE_LABEL_KINDS: ReadonlySet<ExtractionKind> = new Set([
  "CANCEL_LANGUAGE",
  "EXPORT_LANGUAGE",
  "COMPLAINT",
]);

const words = (s: unknown) => (typeof s === "string" && s ? s.replaceAll("_", " ") : null);
const with_ = (head: string, tail: string | null) => (tail ? `${head}: ${tail}` : head);

export function labelOf(kind: ExtractionKind, payload: Record<string, unknown>): DisplayLabel {
  const mk = (text: string, tone: LabelTone): DisplayLabel => ({ kind, text, tone });
  switch (kind) {
    case "SENTIMENT": {
      const l = typeof payload.label === "string" ? payload.label.toLowerCase() : null;
      const tone: LabelTone =
        l === "negative"
          ? "negative"
          : l === "mixed"
            ? "mixed"
            : l === "positive"
              ? "good"
              : "neutral";
      return mk(with_("Sentiment", l), tone);
    }
    case "INTENT":
      return mk(with_("Intent", words(payload.intent)), "neutral");
    case "COMPETITOR":
      return mk(
        with_(
          "Competitor",
          typeof payload.competitorName === "string" ? payload.competitorName : null,
        ),
        "risk",
      );
    case "COMPLAINT":
      return mk(with_("Complaint", words(payload.theme)), "risk");
    case "THEME":
      return mk(with_("Theme", words(payload.theme)), "neutral");
    case "BUDGET_CONCERN":
      return mk("Budget concern", "risk");
    case "CANCEL_LANGUAGE":
      return mk("Cancellation language", "risk");
    case "EXPORT_LANGUAGE":
      return mk("Data-export language", "risk");
    case "RENEWAL_CONCERN":
      return mk("Renewal concern", "risk");
    case "PROMISE":
      return mk(
        with_("Promise", typeof payload.what === "string" ? payload.what : null),
        "neutral",
      );
    case "GOAL":
      return mk(with_("Goal", typeof payload.goal === "string" ? payload.goal : null), "good");
    case "ACTION_ITEM":
      return mk(with_("Action", typeof payload.what === "string" ? payload.what : null), "neutral");
    case "DECISION":
      return mk(
        with_("Decision", typeof payload.decision === "string" ? payload.decision : null),
        "neutral",
      );
  }
}
