import { z } from "zod";

export const ROLE_LABELS = {
  CHAMPION: "Champion",
  DECISION_MAKER: "Decision maker",
  DAILY_USER: "Daily user",
  EXEC_SPONSOR: "Executive sponsor",
  BILLING: "Billing",
  OTHER: "Other",
} as const;

export const CONTACT_STATUS_LABELS = {
  ACTIVE: "Active",
  BOUNCED: "Email bounced",
  LEFT: "Left the company",
  UNKNOWN: "Unknown",
} as const;

export const setChampionInput = z.object({
  accountId: z.string().min(1),
  contactId: z.string().min(1),
});
