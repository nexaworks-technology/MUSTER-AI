/**
 * Pacing calculator for bulk email campaigns (spec §6J2).
 * Distributes outbound messages evenly across the delivery window to prevent
 * provider rate limits, mailbox provider spam flags, and recipient clustering.
 */

const DEFAULT_PACE_PER_HOUR = 100;
const MS_PER_HOUR = 3_600_000;

/**
 * Returns the millisecond interval between individual recipient sends.
 */
export function getIntervalBetweenRecipientsMs(pacePerHour?: number): number {
  const pace = pacePerHour && pacePerHour > 0 ? pacePerHour : DEFAULT_PACE_PER_HOUR;
  return Math.floor(MS_PER_HOUR / pace);
}

export interface PacingOptions {
  scheduledAt: Date;
  pacePerHour?: number;
}

export interface RecipientScheduleOptions extends PacingOptions {
  count: number;
}

/**
 * Computes scheduled send timestamps for N recipients starting at scheduledAt.
 */
export function calculateRecipientSchedule(opts: RecipientScheduleOptions): Date[] {
  const intervalMs = getIntervalBetweenRecipientsMs(opts.pacePerHour);
  const baseTime = opts.scheduledAt.getTime();
  const schedules: Date[] = [];

  for (let i = 0; i < opts.count; i++) {
    schedules.push(new Date(baseTime + i * intervalMs));
  }

  return schedules;
}

export interface RecipientBatchItem {
  id: string;
  scheduledFor: Date;
}

export interface RecipientBatch {
  batchIndex: number;
  windowStart: Date;
  recipients: RecipientBatchItem[];
}

export interface BatchOptions extends PacingOptions {
  recipientIds: string[];
}

/**
 * Partitions recipient IDs into hourly batches based on pacePerHour.
 */
export function computeRecipientBatches(opts: BatchOptions): RecipientBatch[] {
  const pace = opts.pacePerHour && opts.pacePerHour > 0 ? opts.pacePerHour : DEFAULT_PACE_PER_HOUR;
  const intervalMs = getIntervalBetweenRecipientsMs(pace);
  const baseTime = opts.scheduledAt.getTime();
  const batches: RecipientBatch[] = [];

  const total = opts.recipientIds.length;
  let batchIndex = 0;

  for (let start = 0; start < total; start += pace) {
    const chunk = opts.recipientIds.slice(start, start + pace);
    const windowStart = new Date(baseTime + batchIndex * MS_PER_HOUR);

    const recipients: RecipientBatchItem[] = chunk.map((id, offset) => {
      const globalIndex = start + offset;
      return {
        id,
        scheduledFor: new Date(baseTime + globalIndex * intervalMs),
      };
    });

    batches.push({
      batchIndex,
      windowStart,
      recipients,
    });

    batchIndex++;
  }

  return batches;
}
