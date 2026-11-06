import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Risk band chip (ARCHITECTURE §12): colour is reserved for risk — At Risk red, Watch amber,
 * Healthy green, no data grey "Not enough data" (soft-tint pills from the health-band tokens). The word is always shown (never colour alone).
 * The app has a light theme only, so there are no dark-mode variants here.
 */
export type RiskLevelValue = "HEALTHY" | "WATCH" | "AT_RISK" | "INSUFFICIENT_DATA";

export const RISK_WORDS: Record<RiskLevelValue, string> = {
  HEALTHY: "Healthy",
  WATCH: "Watch",
  AT_RISK: "At Risk",
  INSUFFICIENT_DATA: "Not enough data",
};

const VARIANTS = {
  HEALTHY: "healthy",
  WATCH: "watch",
  AT_RISK: "atRisk",
  INSUFFICIENT_DATA: "unknown",
} as const satisfies Record<RiskLevelValue, "healthy" | "watch" | "atRisk" | "unknown">;

export function RiskBadge({ level, className }: { level: RiskLevelValue; className?: string }) {
  return (
    <span
      className={cn(badgeVariants({ variant: VARIANTS[level] }), className)}
      data-testid="risk-badge"
    >
      {RISK_WORDS[level]}
    </span>
  );
}

/** "Score and CSM disagree" marker, shown wherever a score and its Pulse appear. */
export function DisagreementMark() {
  return (
    <span className={badgeVariants({ variant: "accent" })} data-testid="disagreement">
      Score and CSM disagree
    </span>
  );
}
