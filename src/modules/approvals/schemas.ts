import type { ApprovalLevel } from "@prisma/client";

/** Plain words for levels and sensitive reasons on screens (spec §6N1, §6J4). */
export const LEVEL_WORDS: Record<ApprovalLevel, string> = {
  NOTIFY_ONLY: "Notify only",
  DRAFT_FOR_APPROVAL: "Draft for approval",
  DRAFT_IN_MAILBOX: "Draft in mailbox",
  DO_AUTOMATICALLY: "Do automatically",
  SEND_AUTOMATICALLY: "Send automatically",
};

export const SENSITIVE_WORDS: Record<string, string> = {
  cancellation: "Cancellation",
  pricing: "Pricing",
  legal: "Legal",
  security: "Security",
  complaint: "Complaint",
  escalation: "Escalation",
};

export const sensitiveLabel = (reasons: string[]) =>
  `Sensitive: ${reasons.map((r) => (SENSITIVE_WORDS[r] ?? r).toLowerCase()).join(", ")}`;

/** "3 hours", "2 days": how long an approval has waited. */
export function waitingFor(since: Date, now = new Date()): string {
  const hours = Math.max(0, Math.floor((+now - +since) / 3_600_000));
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}
