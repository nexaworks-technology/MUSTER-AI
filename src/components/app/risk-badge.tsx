import { cn } from "@/lib/utils";

/**
 * Risk band chip (ARCHITECTURE §12): colour is reserved for risk — At Risk red, Watch amber,
 * Healthy muted green, no data grey "Not enough data". The word is always shown (never colour alone).
 * The app has a light theme only, so there are no dark-mode variants here.
 */
export type RiskLevelValue = "HEALTHY" | "WATCH" | "AT_RISK" | "INSUFFICIENT_DATA";

export const RISK_WORDS: Record<RiskLevelValue, string> = {
  HEALTHY: "Healthy",
  WATCH: "Watch",
  AT_RISK: "At Risk",
  INSUFFICIENT_DATA: "Not enough data",
};

const STYLES: Record<RiskLevelValue, string> = {
  HEALTHY: "border-emerald-300 bg-emerald-50 text-emerald-900",
  WATCH: "border-amber-300 bg-amber-50 text-amber-900",
  AT_RISK: "border-red-300 bg-red-50 text-red-900",
  INSUFFICIENT_DATA: "border-border bg-muted text-muted-foreground",
};

export function RiskBadge({ level, className }: { level: RiskLevelValue; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        STYLES[level],
        className,
      )}
      data-testid="risk-badge"
    >
      {RISK_WORDS[level]}
    </span>
  );
}

/** "Score and CSM disagree" marker, shown wherever a score and its Pulse appear. */
export function DisagreementMark() {
  return (
    <span
      className="inline-block rounded-full border border-violet-300 bg-violet-50 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-violet-900"
      data-testid="disagreement"
    >
      Score and CSM disagree
    </span>
  );
}
