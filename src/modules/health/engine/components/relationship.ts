import { addDays } from "@/lib/dates";
import { applyCurve } from "../curves";
import { day, plural, round4, TIER_WORDS } from "../format";
import type { AccountBundle, ComponentEnv, ComponentResult, PillarComponents } from "../types";
import { currentHolder, lastEnded, rolesKnown, statusAsOf, validOn } from "./people";

/** Relationship (ARCHITECTURE §4.1, INTERP-2: CSM Pulse is a component here). */
const missing = (component: string, input: string, message: string): ComponentResult => ({
  score: null,
  reason: { component, kind: "MISSING_DATA", input, message, sources: [] },
});

const STATUS_SCORE = { ACTIVE: 100, BOUNCED: 10, LEFT: 0, UNKNOWN: 100 } as const;

function holder(
  b: AccountBundle,
  type: "CHAMPION" | "DECISION_MAKER",
  label: string,
  C: string,
  I: string,
): ComponentResult {
  if (rolesKnown(b, type).length === 0)
    return missing(C, I, `No ${label.toLowerCase()} on record.`);
  const now = currentHolder(b, type);
  if (!now) {
    const ended = lastEnded(b, type);
    return {
      score: 0,
      reason: {
        component: C,
        kind: "EVIDENCE",
        input: I,
        message: ended
          ? `No ${label.toLowerCase()} since ${ended.contact.name}'s role ended (${day(ended.role.validTo!)}).`
          : `No current ${label.toLowerCase()}.`,
        value: 0,
        sources: ended
          ? [
              { sourceType: "StakeholderRole", sourceId: ended.role.id },
              { sourceType: "Contact", sourceId: ended.contact.id },
            ]
          : rolesKnown(b, type).map((r) => ({ sourceType: "StakeholderRole", sourceId: r.id })),
      },
    };
  }
  const status = statusAsOf(now.contact, b.asOf);
  const name = now.contact.name;
  const when = now.contact.statusDate ? ` (${day(now.contact.statusDate)})` : "";
  const message =
    status === "BOUNCED"
      ? `${label} ${name}: email bounced${when}.`
      : status === "LEFT"
        ? `${label} ${name} has left the company${when}.`
        : type === "CHAMPION"
          ? `${label} ${name} is active.`
          : `${label} ${name} is on record.`;
  return {
    score: STATUS_SCORE[status],
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message,
      value: STATUS_SCORE[status],
      sources: [
        { sourceType: "StakeholderRole", sourceId: now.role.id },
        { sourceType: "Contact", sourceId: now.contact.id },
      ],
    },
  };
}

function breadth(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "breadth";
  const I = "people_with_roles";
  const roles = rolesKnown(b).filter((r) => validOn(r, b.asOf));
  if (roles.length === 0) return missing(C, I, "No contacts with a role on record.");
  const people = new Set(
    roles
      .filter((r) => {
        const c = b.contacts.find((x) => x.id === r.contactId);
        return c && statusAsOf(c, b.asOf) === "ACTIVE";
      })
      .map((r) => r.contactId),
  );
  const expected = env.params.expectedContacts[b.tier];
  const ratio = people.size / expected;
  return {
    score: applyCurve(env.curve!, ratio),
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message: `${plural(people.size, "person", "people")} with a role ${people.size === 1 ? "is" : "are"} on record; we expect ${expected} for a ${TIER_WORDS[b.tier]} account.`,
      value: people.size,
      baseline: expected,
      delta: people.size - expected,
      sources: roles.map((r) => ({ sourceType: "StakeholderRole", sourceId: r.id })),
    },
  };
}

function championChange(b: AccountBundle): ComponentResult {
  const C = "champion_change_90d";
  const I = "champion_change_90d";
  const all = rolesKnown(b, "CHAMPION");
  if (all.length === 0) return missing(C, I, "No champion on record.");
  const from = addDays(b.asOf, -89);
  const ended = all
    .filter((r) => r.validTo !== null && r.validTo >= from && r.validTo <= b.asOf)
    .sort((x, y) => (x.validTo! > y.validTo! ? -1 : 1))[0];
  const now = currentHolder(b, "CHAMPION");
  if (!ended)
    return {
      score: 100,
      reason: {
        component: C,
        kind: "EVIDENCE",
        input: I,
        message: "No champion change in the last 90 days.",
        value: 0,
        periodStart: from,
        periodEnd: b.asOf,
        sources: all.map((r) => ({ sourceType: "StakeholderRole", sourceId: r.id })),
      },
    };
  const was = b.contacts.find((c) => c.id === ended.contactId)?.name ?? "the champion";
  const replaced = now && now.role.validFrom >= ended.validFrom;
  return {
    score: replaced ? 30 : 0,
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message: replaced
        ? `Champion changed from ${was} to ${now.contact.name} (${day(ended.validTo!)}).`
        : `Champion ${was}'s role ended on ${day(ended.validTo!)} with no replacement.`,
      value: 1,
      periodStart: from,
      periodEnd: b.asOf,
      sources: [
        { sourceType: "StakeholderRole", sourceId: ended.id },
        ...(replaced ? [{ sourceType: "StakeholderRole", sourceId: now.role.id }] : []),
      ],
    },
  };
}

const PULSE_WORDS = { FINE: "Actually fine", WORRIED: "Worried" } as const;

function pulse(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "pulse";
  const I = "csm_pulse";
  const p = b.pulse;
  if (!p || p.createdDate > b.asOf || b.asOf >= p.expiresDate)
    return missing(C, I, "No current CSM Pulse.");
  const score = env.params.pulseScore[p.value];
  return {
    score,
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message: `${p.authorName}'s Pulse: ${PULSE_WORDS[p.value]}${p.comment ? ` — "${p.comment}"` : ""} (${day(p.createdDate)}).`,
      value: round4(score),
      periodStart: p.createdDate,
      periodEnd: p.expiresDate,
      sources: [{ sourceType: "CsmPulse", sourceId: p.id }],
      pulseValue: p.value,
    },
  };
}

export const RELATIONSHIP: PillarComponents = {
  champion_present: (b) => holder(b, "CHAMPION", "Champion", "champion_present", "champion_status"),
  decision_maker: (b) =>
    holder(b, "DECISION_MAKER", "Decision maker", "decision_maker", "decision_maker_status"),
  breadth,
  champion_change_90d: championChange,
  nps_decision_makers: () =>
    missing("nps_decision_makers", "nps_decision_makers", "No survey responses yet."),
  pulse,
};
