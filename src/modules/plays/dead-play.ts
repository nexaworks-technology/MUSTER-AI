import type { PlayStatus } from "@prisma/client";

export interface DeadPlayCheckInput {
  status: PlayStatus;
  publishedAt: Date | null;
  lastEntryAt: Date | null;
  totalEntries: number;
  now?: Date;
  windowDays?: number;
}

export interface DeadPlayResult {
  isDead: boolean;
  reason?: "NO_ENTRIES_IN_WINDOW" | "NEVER_FIRED";
  message?: string;
  daysSinceLastEntry?: number;
  daysSincePublished?: number;
}

/**
 * Pure evaluation for dead-play detection (spec §2, M8).
 * A published play with no entries over its window (default 30 days)
 * or that has never fired is flagged as dead.
 *
 * Invariant: This function NEVER mutates, disables, or auto-kills the play.
 * It produces a diagnosis for the human operator and flags a Kill action.
 */
export function checkDeadPlay(input: DeadPlayCheckInput): DeadPlayResult {
  const {
    status,
    publishedAt,
    lastEntryAt,
    totalEntries,
    now = new Date(),
    windowDays = 30,
  } = input;

  if (status !== "PUBLISHED" || !publishedAt) {
    return { isDead: false };
  }

  const nowMs = now.getTime();
  const publishedMs = new Date(publishedAt).getTime();
  const daysSincePublished = Math.floor((nowMs - publishedMs) / (1000 * 60 * 60 * 24));

  if (daysSincePublished < windowDays) {
    return { isDead: false, daysSincePublished };
  }

  if (totalEntries === 0) {
    return {
      isDead: true,
      reason: "NEVER_FIRED",
      message: `Play has been published for ${daysSincePublished} days but has never fired.`,
      daysSincePublished,
    };
  }

  if (lastEntryAt) {
    const lastEntryMs = new Date(lastEntryAt).getTime();
    const daysSinceLastEntry = Math.floor((nowMs - lastEntryMs) / (1000 * 60 * 60 * 24));
    if (daysSinceLastEntry >= windowDays) {
      return {
        isDead: true,
        reason: "NO_ENTRIES_IN_WINDOW",
        message: `Play has had no entries in the last ${daysSinceLastEntry} days.`,
        daysSinceLastEntry,
        daysSincePublished,
      };
    }
  }

  return { isDead: false, daysSincePublished };
}
