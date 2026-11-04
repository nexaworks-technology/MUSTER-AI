import type { CalendarDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

/**
 * The Sales handoff (spec §6G1, M6 rule 6): what sales agreed and who the people are, assembled
 * from records only, each item with its sources. A missing item says "Not found in CRM" (Rule 4),
 * never a guess. Item types in M6: contract terms, key people, stated goals, open risks, kickoff
 * notes. Promises made by sales arrive with the Promise model in M9 (not an item type here).
 */
export interface HandoffInput {
  /** Money only for members with revenue access (field-level protection, INTERP-4). */
  showMoney: boolean;
  contract: {
    id: string;
    startDate: CalendarDate;
    valueMinor: bigint | null;
    currency: string;
    seatsPurchased: number | null;
    renewalDate: CalendarDate | null;
    /** The CRM record it came from, when a CRM sync wrote it. */
    crm: { source: string; objectType: string; externalId: string } | null;
  } | null;
  roles: Array<{
    id: string;
    role: string;
    contactId: string;
    contactName: string;
    title: string | null;
  }>;
  goals: Array<{
    id: string;
    text: string;
    sourceType: string | null;
    sourceId: string | null;
    quote: string | null;
    /** AI = read from a call or note by the Watcher (M9), with its quote and run. */
    origin?: "HUMAN" | "SYSTEM" | "AI" | "IMPORT";
  }>;
  /** M9: our side's promises (the Promise Tracker's rows). Absent = none loaded. */
  promises?: Array<{
    id: string;
    what: string;
    party: "US" | "CUSTOMER" | "UNCLEAR";
    status: "OPEN" | "KEPT" | "LATE" | "BROKEN";
    dueDate: CalendarDate | null;
    quote: string | null;
    sourceType: string | null;
    sourceId: string | null;
  }>;
  risks: Array<{ id: string; title: string; severity: string }>;
  kickoffNote: { id: string; date: CalendarDate } | null;
}

export interface HandoffSource {
  sourceType: string;
  sourceId: string;
  label: string;
}

export interface HandoffItem {
  key: string;
  label: string;
  found: boolean;
  text: string;
  values?: string[];
  sources: HandoffSource[];
}

const ROLES: Array<[key: string, role: string, label: string]> = [
  ["champion", "CHAMPION", "Champion"],
  ["decision_maker", "DECISION_MAKER", "Decision maker"],
  ["exec_sponsor", "EXEC_SPONSOR", "Exec sponsor"],
  ["billing_contact", "BILLING", "Billing contact"],
];

const day = (d: CalendarDate) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${d}T00:00:00Z`),
  );

const SOURCE_NAME: Record<string, string> = {
  CALL_TRANSCRIPT: "CallTranscript",
  MESSAGE: "Message",
  NOTE: "Note",
  TICKET: "Ticket",
};
const sourceName = (t: string) => SOURCE_NAME[t] ?? t;

const notFound = (key: string, label: string): HandoffItem => ({
  key,
  label,
  found: false,
  text: `${label}: Not found in CRM`,
  sources: [],
});

export function assembleHandoff(i: HandoffInput): { items: HandoffItem[] } {
  const items: HandoffItem[] = [];
  const c = i.contract;
  const contractSource: HandoffSource[] = c
    ? [
        {
          sourceType: "Contract",
          sourceId: c.id,
          label: c.crm
            ? `Contract (from ${c.crm.source} ${c.crm.objectType} ${c.crm.externalId})`
            : "Contract",
        },
      ]
    : [];
  const contractItem = (key: string, label: string, text: string | null) =>
    c && text !== null
      ? { key, label, found: true, text, sources: contractSource }
      : notFound(key, label);

  items.push(
    contractItem(
      "contract_start",
      "Contract start",
      c ? `Contract starts ${day(c.startDate)}` : null,
    ),
  );
  items.push(
    contractItem(
      "contract_value",
      "Contract value",
      c?.valueMinor === null || !c
        ? null
        : i.showMoney
          ? `${formatMoney({ minor: c.valueMinor, currency: c.currency })} a year`
          : "Contract value on file (revenue access needed to see it)",
    ),
  );
  items.push(
    contractItem(
      "seats_bought",
      "Seats bought",
      c?.seatsPurchased ? `${c.seatsPurchased} seats` : null,
    ),
  );
  items.push(
    contractItem(
      "renewal_date",
      "Renewal date",
      c?.renewalDate ? `Renews ${day(c.renewalDate)}` : null,
    ),
  );

  for (const [key, role, label] of ROLES) {
    const r = i.roles.find((x) => x.role === role);
    items.push(
      r
        ? {
            key,
            label,
            found: true,
            text: r.title ? `${r.contactName}, ${r.title}` : r.contactName,
            sources: [
              { sourceType: "StakeholderRole", sourceId: r.id, label: `${label} role` },
              { sourceType: "Contact", sourceId: r.contactId, label: r.contactName },
            ],
          }
        : notFound(key, label),
    );
  }

  items.push(
    i.goals.length
      ? {
          key: "stated_goals",
          label: "Stated goals",
          found: true,
          text: `${i.goals.length} stated goal${i.goals.length === 1 ? "" : "s"}`,
          values: i.goals.map((g) =>
            g.origin === "AI" && g.sourceType === "CALL_TRANSCRIPT"
              ? `${g.text} (from a call)`
              : g.text,
          ),
          sources: i.goals.flatMap((g) => [
            { sourceType: "Goal", sourceId: g.id, label: g.text },
            ...(g.sourceType && g.sourceId
              ? [
                  {
                    sourceType: sourceName(g.sourceType),
                    sourceId: g.sourceId,
                    label: g.quote ?? g.sourceType,
                  },
                ]
              : []),
          ]),
        }
      : notFound("stated_goals", "Stated goals"),
  );

  // M9: the promises Sales made. A customer's promise is not Sales's; a kept one is not a handoff item.
  const promised = (i.promises ?? []).filter((p) => p.party !== "CUSTOMER" && p.status !== "KEPT");
  items.push(
    promised.length
      ? {
          key: "promises_made",
          label: "Promises made by Sales",
          found: true,
          text: `${promised.length} promise${promised.length === 1 ? "" : "s"} made`,
          values: promised.map((p) =>
            p.dueDate
              ? `${p.what} (due ${day(p.dueDate)}${p.status === "LATE" ? ", late" : p.status === "BROKEN" ? ", broken" : ""})`
              : p.what,
          ),
          sources: promised.flatMap((p) => [
            { sourceType: "Promise", sourceId: p.id, label: p.what },
            ...(p.sourceType && p.sourceId
              ? [
                  {
                    sourceType: sourceName(p.sourceType),
                    sourceId: p.sourceId,
                    label: p.quote ?? sourceName(p.sourceType),
                  },
                ]
              : []),
          ]),
        }
      : notFound("promises_made", "Promises made by Sales"),
  );

  // Open risks are ours, not the CRM's: "none" is a found fact, with no sources to show.
  items.push({
    key: "open_risks",
    label: "Open risks",
    found: true,
    text: i.risks.length
      ? `${i.risks.length} open risk${i.risks.length === 1 ? "" : "s"}`
      : "No open risks",
    values: i.risks.map((r) => r.title),
    sources: i.risks.map((r) => ({ sourceType: "Signal", sourceId: r.id, label: r.title })),
  });

  items.push(
    i.kickoffNote
      ? {
          key: "kickoff_notes",
          label: "Kickoff call notes",
          found: true,
          text: `Kickoff call notes from ${day(i.kickoffNote.date)}`,
          sources: [{ sourceType: "Note", sourceId: i.kickoffNote.id, label: "Kickoff note" }],
        }
      : notFound("kickoff_notes", "Kickoff call notes"),
  );
  return { items };
}
