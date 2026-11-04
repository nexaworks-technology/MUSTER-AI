import type { PromiseStatus } from "@prisma/client";
import { z } from "zod";
import { daysBetween, type CalendarDate } from "@/lib/dates";

/**
 * A promise's status (M9 D1, Rule 2): the one function that decides it, from the due date, today
 * (the business date) and fulfilment evidence. The model proposes a promise; it never sets its
 * status. KEPT needs evidence, so it is never returned without a record to point at; a promise
 * with no date can never be late.
 */
export const brokenAfterDaysSchema = z.number().int().min(1).max(365);
export const DEFAULT_BROKEN_AFTER_DAYS = 14;

export interface PromiseEvidence {
  type: string;
  id: string;
  date: CalendarDate;
}

export interface PromiseStatusInput {
  dueDate: CalendarDate | null;
  today: CalendarDate;
  evidence: PromiseEvidence | null;
  brokenAfterDays: number;
}

export interface PromiseStatusResult {
  status: PromiseStatus;
  reason: string;
  daysLate: number | null;
  sources: Array<{ sourceType: string; sourceId: string }>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function promiseStatus(i: PromiseStatusInput): PromiseStatusResult {
  if (i.evidence) {
    const after = i.dueDate ? daysBetween(i.dueDate, i.evidence.date) : 0;
    return {
      status: "KEPT",
      reason: `Kept: ${i.evidence.type} ${i.evidence.id} on ${i.evidence.date}${
        after > 0 ? `, ${plural(after, "day")} after the due date` : ""
      }.`,
      daysLate: after > 0 ? after : null,
      sources: [{ sourceType: i.evidence.type, sourceId: i.evidence.id }],
    };
  }
  if (!i.dueDate)
    return {
      status: "OPEN",
      reason: "No due date was given, so it cannot be late.",
      daysLate: null,
      sources: [],
    };
  const late = daysBetween(i.dueDate, i.today);
  if (late <= 0)
    return {
      status: "OPEN",
      reason: late === 0 ? "Due today." : `Due in ${plural(-late, "day")}, on ${i.dueDate}.`,
      daysLate: null,
      sources: [],
    };
  const broken = late >= i.brokenAfterDays;
  return {
    status: broken ? "BROKEN" : "LATE",
    reason: `${plural(late, "day")} late: it was due on ${i.dueDate} and nothing shows it was done${
      broken ? `; broken after ${plural(i.brokenAfterDays, "day")} late` : ""
    }.`,
    daysLate: late,
    sources: [],
  };
}
