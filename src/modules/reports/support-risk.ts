import { calendarDateOf, type CalendarDate } from "@/lib/dates";
import { percentile } from "@/modules/health/service";
import { count, measure } from "./figures";
import type { ReportContent } from "./types";

/**
 * Support risk (spec §6G). Tickets and the open support-category signals for the accounts in
 * scope, as the tickets tab and signal list hold them. No threshold is invented: the report
 * counts what is open, escalated, high priority and unanswered, and the median first response.
 */
export interface SupportRiskInput {
  periodStart: CalendarDate;
  periodEnd: CalendarDate;
  query: string;
  tickets: Array<{
    id: string;
    accountId: string;
    status: "OPEN" | "PENDING" | "SOLVED" | "CLOSED";
    priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
    isEscalated: boolean;
    openedAt: Date;
    firstResponseAt: Date | null;
  }>;
  /** Open signals in the SUPPORT category. */
  signals: Array<{ id: string; accountId: string }>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function supportRiskReport(i: SupportRiskInput): ReportContent {
  const row = (t: { id: string; accountId: string }) => ({ id: t.id, accountId: t.accountId });
  const open = i.tickets.filter((t) => t.status === "OPEN" || t.status === "PENDING");
  const inPeriod = i.tickets.filter((t) => {
    const d = calendarDateOf(t.openedAt);
    return d >= i.periodStart && d <= i.periodEnd;
  });
  const answered = inPeriod.filter((t) => t.firstResponseAt !== null);
  const hours = answered.map(
    (t) => (t.firstResponseAt!.getTime() - t.openedAt.getTime()) / 3_600_000,
  );
  const median = hours.length ? round1(percentile(hours, 0.5)!) : null;
  const signalAccounts = [...new Set(i.signals.map((s) => s.accountId))];

  return {
    notes: [],
    sections: [
      {
        title: "Open now",
        figures: [
          count("Tickets open now", "Ticket", open.map(row)),
          count("Open and escalated", "Ticket", open.filter((t) => t.isEscalated).map(row)),
          count(
            "Open at high or urgent priority",
            "Ticket",
            open.filter((t) => t.priority === "HIGH" || t.priority === "URGENT").map(row),
          ),
        ],
      },
      {
        title: "In the period",
        figures: [
          count("Tickets opened in the period", "Ticket", inPeriod.map(row)),
          measure(
            "Median first response",
            "hours",
            median,
            "Ticket",
            answered.map(row),
            "No ticket opened in this period has had a first response.",
          ),
          count(
            "Opened in the period and not yet answered",
            "Ticket",
            inPeriod.filter((t) => t.firstResponseAt === null).map(row),
          ),
        ],
      },
      {
        title: "Support signals",
        figures: [
          count(
            "Accounts with an open support signal",
            "Account",
            signalAccounts.map((id) => ({ id, accountId: id })),
          ),
          count("Open support signals", "Signal", i.signals.map(row)),
        ],
      },
    ],
  };
}
