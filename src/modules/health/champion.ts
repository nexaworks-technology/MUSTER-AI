import { daysBetween } from "@/lib/dates";
import { currentHolder, lastEnded, statusAsOf } from "./engine/components/people";
import type { AccountBundle, SourceRef as Source } from "./engine/types";

/**
 * The champion's state on the bundle's date (M7 j): the one deterministic definition of "silent",
 * used by the renewal confidence now and by M9's `champion-silent` rule later, so the two can
 * never disagree. Pure over the point-in-time bundle: only records dated on or before `asOf`.
 *
 * - GONE: the champion role has ended, or the person's email bounced or they left.
 * - SILENT: the person holds the role but nothing has been heard from them (an inbound message,
 *   or product activity) for `silentAfterDays` or more; counted from the role's start when they
 *   have never been heard from.
 * - ACTIVE: otherwise. No champion role on record at all: null (Rule 4, not bad news).
 */
export interface ChampionState {
  state: "ACTIVE" | "SILENT" | "GONE";
  contactId: string;
  name: string;
  silentDays: number | null;
  lastHeard: string | null;
  sources: Source[];
}

export function championState(b: AccountBundle, silentAfterDays: number): ChampionState | null {
  const holder = currentHolder(b, "CHAMPION");
  if (!holder) {
    const ended = lastEnded(b, "CHAMPION");
    if (!ended) return null;
    return {
      state: "GONE",
      contactId: ended.contact.id,
      name: ended.contact.name,
      silentDays: null,
      lastHeard: null,
      sources: [{ sourceType: "Contact", sourceId: ended.contact.id }],
    };
  }
  const { contact, role } = holder;
  const base: Source[] = [{ sourceType: "Contact", sourceId: contact.id }];
  const status = statusAsOf(contact, b.asOf);
  if (status === "LEFT" || status === "BOUNCED")
    return {
      state: "GONE",
      contactId: contact.id,
      name: contact.name,
      silentDays: null,
      lastHeard: null,
      sources: base,
    };
  const heard: Array<{ date: string; source: Source }> = [
    ...(b.messages ?? [])
      .filter(
        (m) => m.fromContactId === contact.id && m.direction === "INBOUND" && m.date <= b.asOf,
      )
      .map((m) => ({ date: m.date, source: { sourceType: "Message", sourceId: m.id } })),
    ...(b.userUsage ?? [])
      .filter((u) => u.contactId === contact.id && u.events > 0 && u.date <= b.asOf)
      .map((u) => ({
        date: u.date,
        source: { sourceType: "UserUsageDaily", accountId: b.accountId, from: u.date, to: u.date },
      })),
  ].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  const last = heard[0];
  const days = daysBetween(last?.date ?? role.validFrom, b.asOf);
  return {
    state: days >= silentAfterDays ? "SILENT" : "ACTIVE",
    contactId: contact.id,
    name: contact.name,
    silentDays: days,
    lastHeard: last?.date ?? null,
    sources: last ? [...base, last.source] : base,
  };
}
