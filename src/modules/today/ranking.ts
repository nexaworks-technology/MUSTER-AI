import type { TodayItemType } from "@prisma/client";
import { daysBetween, type CalendarDate } from "@/lib/dates";

/**
 * Today ranking (ARCHITECTURE §9, spec §6F1): rankScore = moneyWeight × urgency, both computed in
 * code and stored with plain-word reasons. Pure and test-first. Revenue access changes the words,
 * never the order (§9: "the user still sees the ranking, but not the ARR value").
 */
export type Driver =
  | { kind: "TASK_DUE"; dueDate: CalendarDate }
  | { kind: "ESCALATED_TASK"; dueDate: CalendarDate; ownerName: string }
  | { kind: "SIGNAL"; severity: "CRITICAL" | "WARN" | "INFO" }
  | { kind: "RENEWAL"; renewalDate: CalendarDate }
  | { kind: "APPROVAL"; waitingHours: number }
  | { kind: "MEETING" };

export interface Candidate {
  itemType: TodayItemType;
  refId: string;
  title: string;
  accountId: string | null;
  accountName: string | null;
  arrMinor: bigint | null;
  currency: string;
  renewalDate: CalendarDate | null;
  driver: Driver;
  dueAt?: Date | null;
}

export interface Reason {
  kind: "money" | "urgency";
  label: string;
}

export interface Ranked extends Candidate {
  rankScore: number;
  rankReasons: Reason[];
}

const OVERDUE_CAP = 2;

export function moneyWeight(arrMinor: bigint | null): number {
  const units = arrMinor === null ? 0 : Number(arrMinor) / 100;
  return 1 + Math.log10(1 + Math.max(0, units) / 1000);
}

export function urgencyOf(d: Driver, today: CalendarDate): number {
  switch (d.kind) {
    case "TASK_DUE":
    case "ESCALATED_TASK": {
      const late = daysBetween(d.dueDate, today);
      if (late <= 0) return 0.8;
      return Math.min(OVERDUE_CAP, Math.round((1 + 0.1 * late) * 100) / 100);
    }
    case "SIGNAL":
      return d.severity === "CRITICAL" ? 0.9 : d.severity === "WARN" ? 0.5 : 0.2;
    case "RENEWAL": {
      const days = daysBetween(today, d.renewalDate);
      return days <= 30 ? 0.9 : days <= 60 ? 0.6 : 0.4;
    }
    case "APPROVAL":
      // §9 sets 0.7 after 24 h; a fresh approval still waits on the person: 0.5 (D-78).
      return d.waitingHours > 24 ? 0.7 : 0.5;
    case "MEETING":
      return 0.7;
  }
}

const money = (minor: bigint, currency: string) => {
  const units = Number(minor) / 100;
  const sym = currency === "USD" ? "$" : `${currency} `;
  return units >= 1000 ? `${sym}${Math.round(units / 1000)}k` : `${sym}${Math.round(units)}`;
};

function urgencyLabel(d: Driver, today: CalendarDate): string {
  switch (d.kind) {
    case "TASK_DUE":
    case "ESCALATED_TASK": {
      const late = daysBetween(d.dueDate, today);
      const when = late <= 0 ? "due today" : `overdue ${late} day${late === 1 ? "" : "s"}`;
      return d.kind === "ESCALATED_TASK" ? `escalated: ${d.ownerName}'s task, ${when}` : when;
    }
    case "SIGNAL":
      return `${d.severity === "CRITICAL" ? "Critical" : d.severity === "WARN" ? "Warning" : "Info"} signal`;
    case "RENEWAL": {
      const days = daysBetween(today, d.renewalDate);
      return `renews in ${days} day${days === 1 ? "" : "s"}`;
    }
    case "APPROVAL":
      return d.waitingHours > 24
        ? `waiting ${Math.floor(d.waitingHours / 24)} day(s) for you`
        : "waiting for you";
    case "MEETING":
      return "meeting today";
  }
}

export function rankItems(
  items: Candidate[],
  opts: { today: CalendarDate; canViewRevenue: boolean },
): Ranked[] {
  return items
    .map((i): Ranked => {
      const score = moneyWeight(i.arrMinor) * urgencyOf(i.driver, opts.today);
      const moneyLabel =
        opts.canViewRevenue && i.arrMinor !== null && i.arrMinor > 0n
          ? `${money(i.arrMinor, i.currency)} ARR`
          : "Account value";
      return {
        ...i,
        rankScore: Math.round(score * 1e6) / 1e6,
        rankReasons: [
          { kind: "money", label: moneyLabel },
          { kind: "urgency", label: urgencyLabel(i.driver, opts.today) },
        ],
      };
    })
    .sort(
      (a, b) =>
        b.rankScore - a.rankScore ||
        (a.renewalDate ?? "9999-12-31").localeCompare(b.renewalDate ?? "9999-12-31") ||
        (a.accountName ?? "").localeCompare(b.accountName ?? "") ||
        a.refId.localeCompare(b.refId),
    );
}
