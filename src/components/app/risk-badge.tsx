import { StatusPill } from "@/components/app/status-pill";

/**
 * Risk band chip (ARCHITECTURE §12): colour is reserved for risk — At Risk red, Watch amber,
 * Healthy green, no data grey "Not enough data" (soft-tint pills from the health-band tokens).
 * The word is always shown (never colour alone).
 */
export type RiskLevelValue = "HEALTHY" | "WATCH" | "AT_RISK" | "INSUFFICIENT_DATA";

export const RISK_WORDS: Record<RiskLevelValue, string> = {
  HEALTHY: "Healthy",
  WATCH: "Watch",
  AT_RISK: "At Risk",
  INSUFFICIENT_DATA: "Not enough data",
};

const PILL_VARIANTS = {
  HEALTHY: "healthy",
  WATCH: "watch",
  AT_RISK: "atRisk",
  INSUFFICIENT_DATA: "neutral",
} as const;

export function RiskBadge({ level, className }: { level: RiskLevelValue; className?: string }) {
  return (
    <StatusPill
      variant={PILL_VARIANTS[level]}
      className={className}
      data-testid="risk-badge"
    >
      {RISK_WORDS[level]}
    </StatusPill>
  );
}

/** "Score and CSM disagree" marker, shown wherever a score and its Pulse appear. */
export function DisagreementMark() {
  return (
    <StatusPill variant="accent" data-testid="disagreement">
      Score and CSM disagree
    </StatusPill>
  );
}
