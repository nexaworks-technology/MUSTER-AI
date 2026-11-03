import type { AccountTier, ApprovalLevel } from "@prisma/client";

/**
 * Approval levels (ARCHITECTURE §7.3, spec §6N1): effective = min(step level for the account's
 * tier, workspace ceiling, sensitive cap). Pure and test-first.
 */
export const LEVELS: readonly ApprovalLevel[] = [
  "NOTIFY_ONLY",
  "DRAFT_FOR_APPROVAL",
  "DRAFT_IN_MAILBOX",
  "DO_AUTOMATICALLY",
  "SEND_AUTOMATICALLY",
];

const rank = (l: ApprovalLevel) => LEVELS.indexOf(l);
export const minLevel = (...ls: ApprovalLevel[]): ApprovalLevel =>
  ls.reduce((a, b) => (rank(a) <= rank(b) ? a : b));

/** Tier defaults (§7.3): customer contact always needs a human by default. */
export const DEFAULT_LEVELS: Record<
  "customerFacing" | "internal",
  Record<AccountTier, ApprovalLevel>
> = {
  customerFacing: {
    HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
    MID_TOUCH: "DRAFT_FOR_APPROVAL",
    LONG_TAIL: "DRAFT_FOR_APPROVAL",
  },
  internal: {
    HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
    MID_TOUCH: "DO_AUTOMATICALLY",
    LONG_TAIL: "DO_AUTOMATICALLY",
  },
};

export interface LevelInput {
  tier: AccountTier;
  customerFacing: boolean;
  workspaceCeiling: ApprovalLevel;
  isSensitive: boolean;
  /** The auto-send kill switch (forced off until M8). */
  autoSendEnabled: boolean;
  /** The play step's configured level; defaults to the tier default. */
  stepLevel?: ApprovalLevel;
  /** Seeded plays mark safe steps; only those may auto-send on long-tail accounts. */
  safeStep?: boolean;
}

export function resolveLevel(i: LevelInput): ApprovalLevel {
  const defaults = DEFAULT_LEVELS[i.customerFacing ? "customerFacing" : "internal"];
  let level = minLevel(i.stepLevel ?? defaults[i.tier], i.workspaceCeiling);
  if (i.customerFacing) {
    // DO_AUTOMATICALLY covers internal actions only; a mailbox draft needs email write-back (M9).
    if (level === "DO_AUTOMATICALLY" || level === "DRAFT_IN_MAILBOX") level = "DRAFT_FOR_APPROVAL";
    const mayAuto = i.tier === "LONG_TAIL" && i.safeStep === true && i.autoSendEnabled;
    if (level === "SEND_AUTOMATICALLY" && !mayAuto) level = "DRAFT_FOR_APPROVAL";
  } else if (level === "SEND_AUTOMATICALLY") {
    level = "DO_AUTOMATICALLY";
  }
  // The sensitive cap wins over every setting (Rule 3; DB CHECK approval_sensitive_cap).
  if (i.isSensitive) level = minLevel(level, "DRAFT_FOR_APPROVAL");
  return level;
}
