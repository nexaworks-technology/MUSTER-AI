import type { ScopedDb } from "@/lib/db/scoped";
import { calendarDateOf } from "@/lib/dates";
import { day, period } from "./engine/format";
import type { SourceRef } from "./engine/types";

/**
 * Turns a reason's source pointers into links to the exact record or window (spec §6C2, M3 rule 2).
 * Pure description + one batched lookup per source type.
 */
export const SOURCE_TYPES = [
  "UsageDaily",
  "UserUsageDaily",
  "FeatureUsageDaily",
  "Contract",
  "Invoice",
  "RevenueEvent",
  "Ticket",
  "Message",
  "Contact",
  "StakeholderRole",
  "CsmPulse",
] as const;

export interface SourceLookups {
  usageDate: Map<string, string>;
  roleContact: Map<string, { contactId: string; role: string; name: string }>;
  /** id → display name (contact name, invoice number, ticket subject). */
  names: Map<string, string>;
  /** Messages that are ticket replies: they are shown on the Tickets tab, under their ticket. */
  messageTicket: Map<string, { ticketId: string; subject: string }>;
  existing: Set<string>;
}

export interface ResolvedSource {
  label: string;
  href: string | null;
  missing: boolean;
}

const ROLE_WORDS: Record<string, string> = {
  CHAMPION: "Champion",
  DECISION_MAKER: "Decision maker",
  EXEC_SPONSOR: "Exec sponsor",
  DAILY_USER: "Daily user",
  BILLING: "Billing",
  OTHER: "Other",
};

export function describeSource(
  accountId: string,
  ref: SourceRef,
  look: SourceLookups,
): ResolvedSource {
  const base = `/accounts/${accountId}`;
  const win = ref.from && ref.to ? period(ref.from, ref.to) : "";
  const range = ref.from && ref.to ? `?from=${ref.from}&to=${ref.to}` : "";
  if (!ref.sourceId) {
    const windows: Record<string, [string, string]> = {
      UsageDaily: [`Usage, ${win}`, `${base}/usage${range}#usage-chart`],
      UserUsageDaily: [`People's usage, ${win}`, `${base}/usage${range}#top-users`],
      FeatureUsageDaily: [`Feature usage, ${win}`, `${base}/usage${range}#features`],
      Invoice: [`Invoices, ${win}`, `${base}/billing#invoices`],
      RevenueEvent: [`ARR changes, ${win}`, `${base}/billing#revenue`],
      Ticket: [`Tickets, ${win}`, `${base}/tickets`],
      Message: [`Emails, ${win}`, `${base}/conversations`],
    };
    const w = windows[ref.sourceType];
    if (!w) throw new Error(`No window link for ${ref.sourceType}`);
    return { label: w[0], href: w[1], missing: false };
  }
  const id = ref.sourceId;
  if (!look.existing.has(id))
    return {
      label: `${ref.sourceType.replace(/([a-z])([A-Z])/g, "$1 $2")} (no longer on record)`,
      href: null,
      missing: true,
    };
  switch (ref.sourceType) {
    case "UsageDaily": {
      const d = look.usageDate.get(id)!;
      return {
        label: `Usage on ${day(d)}`,
        href: `${base}/usage?from=${d}&to=${d}#usage-chart`,
        missing: false,
      };
    }
    case "Contract":
      return { label: "Contract", href: `${base}/billing#contract-${id}`, missing: false };
    case "Invoice":
      return {
        label: `Invoice ${look.names.get(id) ?? ""}`.trim(),
        href: `${base}/billing#invoice-${id}`,
        missing: false,
      };
    case "RevenueEvent":
      return { label: "ARR change", href: `${base}/billing#revenue-${id}`, missing: false };
    case "Ticket":
      return {
        label: `Ticket: ${look.names.get(id) ?? id}`,
        href: `${base}/tickets#ticket-${id}`,
        missing: false,
      };
    case "Message": {
      const t = look.messageTicket.get(id);
      return t
        ? {
            label: `Ticket message: ${t.subject}`,
            href: `${base}/tickets#ticket-${t.ticketId}`,
            missing: false,
          }
        : {
            label: "Message",
            href: `${base}/conversations?message=${id}#message-${id}`,
            missing: false,
          };
    }
    case "Contact":
      return {
        label: `Contact: ${look.names.get(id) ?? id}`,
        href: `${base}/people#contact-${id}`,
        missing: false,
      };
    case "StakeholderRole": {
      const r = look.roleContact.get(id)!;
      return {
        label: `${ROLE_WORDS[r.role] ?? r.role} role: ${r.name}`,
        href: `${base}/people#contact-${r.contactId}`,
        missing: false,
      };
    }
    case "CsmPulse":
      return { label: "CSM Pulse", href: `${base}/health#pulse`, missing: false };
    default:
      throw new Error(`No link for source type ${ref.sourceType}`);
  }
}

/** One batched lookup per source type for all the given pointers (no N+1). */
export async function sourceLookups(db: ScopedDb, refs: SourceRef[]): Promise<SourceLookups> {
  const ids = (t: string) => [
    ...new Set(refs.filter((r) => r.sourceType === t && r.sourceId).map((r) => r.sourceId!)),
  ];
  const [usage, roles, contacts, invoices, tickets, contracts, events, messages, pulses] =
    await Promise.all([
      db.usageDaily.findMany({
        where: { id: { in: ids("UsageDaily") } },
        select: { id: true, date: true },
      }),
      db.stakeholderRole.findMany({
        where: { id: { in: ids("StakeholderRole") } },
        select: { id: true, contactId: true, role: true, contact: { select: { name: true } } },
      }),
      db.contact.findMany({
        where: { id: { in: ids("Contact") } },
        select: { id: true, name: true },
      }),
      db.invoice.findMany({
        where: { id: { in: ids("Invoice") } },
        select: { id: true, number: true },
      }),
      db.ticket.findMany({
        where: { id: { in: ids("Ticket") } },
        select: { id: true, subject: true },
      }),
      db.contract.findMany({ where: { id: { in: ids("Contract") } }, select: { id: true } }),
      db.revenueEvent.findMany({
        where: { id: { in: ids("RevenueEvent") } },
        select: { id: true },
      }),
      db.message.findMany({
        where: { id: { in: ids("Message") } },
        select: {
          id: true,
          conversation: {
            select: {
              channel: true,
              tickets: { select: { id: true, subject: true }, orderBy: { id: "asc" }, take: 1 },
            },
          },
        },
      }),
      db.csmPulse.findMany({ where: { id: { in: ids("CsmPulse") } }, select: { id: true } }),
    ]);
  const existing = new Set<string>(
    [usage, roles, contacts, invoices, tickets, contracts, events, messages, pulses].flatMap(
      (rows) => rows.map((r) => r.id),
    ),
  );
  return {
    usageDate: new Map(usage.map((u) => [u.id, calendarDateOf(u.date)])),
    roleContact: new Map(
      roles.map((r) => [r.id, { contactId: r.contactId, role: r.role, name: r.contact.name }]),
    ),
    names: new Map([
      ...contacts.map((c) => [c.id, c.name] as const),
      ...invoices.map((i) => [i.id, i.number] as const),
      ...tickets.map((t) => [t.id, t.subject] as const),
    ]),
    messageTicket: new Map(
      messages.flatMap((m) => {
        const t = m.conversation.channel === "TICKET" ? m.conversation.tickets[0] : undefined;
        return t ? [[m.id, { ticketId: t.id, subject: t.subject }] as const] : [];
      }),
    ),
    existing,
  };
}
