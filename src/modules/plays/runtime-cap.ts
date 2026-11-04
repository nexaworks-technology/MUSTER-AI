export interface RuntimeCapInput {
  now: Date;
  contactCooldownHours: number;
  lastSentToContactAt?: Date | null;
  otherPlayCooldownHours: number;
  lastOtherSendToAccountAt?: Date | null;
}

export interface RuntimeCapResult {
  breached: boolean;
  guard?: "contact_recently_emailed" | "account_recently_emailed";
  reason?: string;
}

const HOUR_MS = 60 * 60 * 1000;

export function checkRuntimeFrequencyCap(input: RuntimeCapInput): RuntimeCapResult {
  if (input.lastSentToContactAt) {
    const elapsedMs = input.now.getTime() - input.lastSentToContactAt.getTime();
    const cooldownMs = input.contactCooldownHours * HOUR_MS;
    if (elapsedMs >= 0 && elapsedMs < cooldownMs) {
      const elapsedHours = Math.floor(elapsedMs / HOUR_MS);
      return {
        breached: true,
        guard: "contact_recently_emailed",
        reason: `This contact was emailed ${elapsedHours} hours ago (limit ${input.contactCooldownHours}).`,
      };
    }
  }

  if (input.lastOtherSendToAccountAt) {
    const elapsedMs = input.now.getTime() - input.lastOtherSendToAccountAt.getTime();
    const cooldownMs = input.otherPlayCooldownHours * HOUR_MS;
    if (elapsedMs >= 0 && elapsedMs < cooldownMs) {
      const elapsedHours = Math.floor(elapsedMs / HOUR_MS);
      return {
        breached: true,
        guard: "account_recently_emailed",
        reason: `Another send reached this account ${elapsedHours} hours ago (limit ${input.otherPlayCooldownHours}).`,
      };
    }
  }

  return { breached: false };
}
