import { daysBetween, type CalendarDate } from "@/lib/dates";
import {
  championState,
  formatDay,
  rolesKnown,
  statusAsOf,
  validOn,
} from "@/modules/health/service";
import type { ParamsOf } from "./catalog";
import type { Evidence, SignalBundle, SignalCandidate } from "./index";

/**
 * The M9 people rules. `champion_silent` asks the one champion-silence function (D-119,
 * health/champion.ts) and only decides severity; bounced and left champions stay with
 * `contact_bounced_or_left` (D6). A title change comes from the database stamp on the contact.
 */
export interface TitleChange {
  contactId: string;
  name: string;
  previousTitle: string;
  title: string;
  changedOn: CalendarDate;
}

const word = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const within = (date: CalendarDate, asOf: CalendarDate, days: number) =>
  date <= asOf && daysBetween(date, asOf) < days;

export const PEOPLE_EVALUATORS = {
  champion_silent: (b: SignalBundle, p: ParamsOf<"champion_silent">): SignalCandidate[] => {
    const s = championState(b, p.silentAfterDays);
    if (!s || s.state !== "SILENT" || s.silentDays === null) return [];
    const evidence: Evidence[] = [
      ...s.sources.map((x) => ({
        ...x,
        ...(x.sourceType === "Contact" ? { value: s.silentDays, date: s.lastHeard } : {}),
      })),
    ];
    return [
      {
        dedupeKey: `champion_silent:${b.accountId}:${s.contactId}`,
        severity: s.silentDays >= p.criticalAfterDays ? "CRITICAL" : "WARN",
        title: `Champion ${s.name} silent for ${s.silentDays} days`,
        explanation: s.lastHeard
          ? `${s.name} is the recorded champion; the last message or product activity from them was on ${formatDay(s.lastHeard)}.`
          : `${s.name} is the recorded champion and nothing has been heard from them since the role began.`,
        evidence,
        values: { silentDays: s.silentDays },
      },
    ];
  },

  champion_role_change: (b: SignalBundle, p: ParamsOf<"champion_role_change">): SignalCandidate[] =>
    (b.people?.titleChanges ?? []).flatMap((t) => {
      if (!within(t.changedOn, b.asOf, p.windowDays)) return [];
      const contact = b.contacts.find((c) => c.id === t.contactId);
      if (!contact) return [];
      const status = statusAsOf(contact, b.asOf);
      if (status === "BOUNCED" || status === "LEFT") return [];
      const role = rolesKnown(b).find(
        (r) => r.contactId === t.contactId && r.role === "CHAMPION" && validOn(r, b.asOf),
      );
      if (!role) return [];
      return [
        {
          dedupeKey: `champion_role_change:${b.accountId}:${t.contactId}:${t.changedOn}`,
          severity: "WARN" as const,
          title: `Champion ${t.name}: title changed to ${t.title}`,
          explanation: `${t.name}, the recorded champion, went from “${t.previousTitle}” to “${t.title}” on ${formatDay(t.changedOn)}. A move inside the same company is a known false alarm: they may still be a strong champion.`,
          evidence: [
            { sourceType: "Contact", sourceId: t.contactId, value: t.title, date: t.changedOn },
            { sourceType: "StakeholderRole", sourceId: role.id, value: "CHAMPION" },
          ],
          values: { previousTitle: t.previousTitle, title: t.title },
        },
      ];
    }),

  new_decision_maker: (b: SignalBundle, p: ParamsOf<"new_decision_maker">): SignalCandidate[] => {
    const roles = rolesKnown(b);
    return roles
      .filter(
        (r) =>
          (r.role === "DECISION_MAKER" || r.role === "EXEC_SPONSOR") &&
          validOn(r, b.asOf) &&
          within(r.validFrom, b.asOf, p.windowDays) &&
          roles.some(
            (o) =>
              o.id !== r.id &&
              o.role === r.role &&
              o.contactId !== r.contactId &&
              o.validTo !== null &&
              o.validTo <= r.validFrom,
          ),
      )
      .map((r) => {
        const c = b.contacts.find((x) => x.id === r.contactId);
        const label = r.role === "EXEC_SPONSOR" ? "exec sponsor" : "decision maker";
        return {
          dedupeKey: `new_decision_maker:${b.accountId}:${r.contactId}`,
          severity: "INFO" as const,
          title: `New ${label}: ${c?.name ?? "a new contact"}`,
          explanation: `${c?.name ?? "A new contact"} became the ${label} on ${formatDay(r.validFrom)}, after an earlier holder of the role ended.`,
          evidence: [
            { sourceType: "StakeholderRole", sourceId: r.id, value: r.role, date: r.validFrom },
            { sourceType: "Contact", sourceId: r.contactId },
          ],
          values: { role: r.role },
        };
      });
  },

  email_engagement_stops: (
    b: SignalBundle,
    p: ParamsOf<"email_engagement_stops">,
  ): SignalCandidate[] => {
    const inbound = (b.messages ?? []).filter(
      (m) => m.channel === "EMAIL" && m.direction === "INBOUND" && m.date <= b.asOf,
    );
    if (inbound.length === 0) return [];
    const quietFrom = b.asOf;
    const recent = inbound.filter((m) => within(m.date, quietFrom, p.quietDays));
    if (recent.length > 0) return [];
    const before = inbound.filter(
      (m) => daysBetween(m.date, b.asOf) < p.quietDays + p.baselineDays,
    );
    if (before.length < p.minMessages) return [];
    const last = [...before].sort((x, y) => (x.date < y.date ? 1 : -1))[0]!;
    return [
      {
        dedupeKey: `email_engagement_stops:${b.accountId}`,
        severity: "WARN",
        title: "Customer emails have stopped",
        explanation: `${word(before.length, "inbound email")} in the ${p.baselineDays} days before, and none in the last ${p.quietDays} days. The last one was on ${formatDay(last.date)}.`,
        evidence: [
          { sourceType: "Message", sourceId: last.id, date: last.date, value: before.length },
        ],
        values: { before: before.length, quietDays: p.quietDays },
      },
    ];
  },
};
