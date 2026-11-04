import { daysBetween, type CalendarDate } from "@/lib/dates";

/**
 * Champion Guard's deterministic part (M9 B4, spec §6E10): who could be the next champion, ranked by
 * what the records show. Every candidate carries the reasons and their sources, never a bare number:
 * the order is internal, the proof is what is shown. The model only explains and drafts; it never
 * picks. Eligible: active, with an email, not the champion who is gone.
 */
export type CandidateRole =
  "DECISION_MAKER" | "EXEC_SPONSOR" | "DAILY_USER" | "BILLING" | "OTHER" | "CHAMPION";

export interface CandidatePerson {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  status: "ACTIVE" | "BOUNCED" | "LEFT" | "UNKNOWN";
  /** Roles they hold on the as-of date. */
  roles: Array<{ id: string; role: CandidateRole }>;
  /** Their inbound messages (dated). */
  inbound: Array<{ id: string; date: CalendarDate }>;
  /** Days in the last 30 on which they used the product. */
  activeDaysLast30: number;
}

export interface Candidate {
  contactId: string;
  name: string;
  title: string | null;
  reasons: Array<{
    text: string;
    sources: Array<{
      sourceType: string;
      sourceId?: string;
      accountId?: string;
      from?: CalendarDate;
      to?: CalendarDate;
    }>;
  }>;
}

const ROLE_POINTS: Partial<Record<CandidateRole, number>> = {
  DECISION_MAKER: 40,
  EXEC_SPONSOR: 30,
  DAILY_USER: 10,
};
const ROLE_WORDS: Partial<Record<CandidateRole, string>> = {
  DECISION_MAKER: "Decision maker",
  EXEC_SPONSOR: "Exec sponsor",
  DAILY_USER: "Daily user",
};
const day = (d: CalendarDate) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${d}T00:00:00Z`),
  );
const within = (date: CalendarDate, asOf: CalendarDate, days: number) =>
  date <= asOf && daysBetween(date, asOf) < days;

export function rankCandidates(i: {
  asOf: CalendarDate;
  accountId: string;
  goneContactId: string | null;
  people: CandidatePerson[];
}): Candidate[] {
  const scored = i.people
    .filter((p) => p.id !== i.goneContactId && p.status === "ACTIVE" && p.email)
    .map((p) => {
      let points = 0;
      const reasons: Candidate["reasons"] = [];
      const best = p.roles
        .filter((r) => ROLE_POINTS[r.role] !== undefined)
        .sort((a, b) => ROLE_POINTS[b.role]! - ROLE_POINTS[a.role]!)[0];
      if (best) {
        points += ROLE_POINTS[best.role]!;
        reasons.push({
          text: ROLE_WORDS[best.role]!,
          sources: [{ sourceType: "StakeholderRole", sourceId: best.id }],
        });
      }
      const recent = p.inbound
        .filter((m) => within(m.date, i.asOf, 90))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? -1 : 1));
      if (recent.length) {
        points += Math.min(recent.length, 5) * 5;
        if (within(recent[0]!.date, i.asOf, 30)) points += 15;
        reasons.push({
          text: `Wrote to us ${recent.length} time${recent.length === 1 ? "" : "s"} in the last 90 days, most recently on ${day(recent[0]!.date)}`,
          sources: recent.map((m) => ({ sourceType: "Message", sourceId: m.id })),
        });
      }
      if (p.activeDaysLast30 > 0) {
        points += Math.min(p.activeDaysLast30, 10);
        const from = new Date(`${i.asOf}T00:00:00Z`);
        from.setUTCDate(from.getUTCDate() - 29);
        reasons.push({
          text: `Active in the product on ${p.activeDaysLast30} of the last 30 days`,
          sources: [
            {
              sourceType: "UserUsageDaily",
              accountId: i.accountId,
              from: from.toISOString().slice(0, 10),
              to: i.asOf,
            },
          ],
        });
      }
      if (reasons.length === 0)
        reasons.push({
          text: "On file with an email address; nothing else in the records shows their involvement",
          sources: [{ sourceType: "Contact", sourceId: p.id }],
        });
      return {
        points,
        candidate: { contactId: p.id, name: p.name, title: p.title, reasons } satisfies Candidate,
      };
    });
  return scored
    .sort(
      (a, b) =>
        b.points - a.points ||
        a.candidate.name.localeCompare(b.candidate.name) ||
        (a.candidate.contactId < b.candidate.contactId ? -1 : 1),
    )
    .map((s) => s.candidate);
}
