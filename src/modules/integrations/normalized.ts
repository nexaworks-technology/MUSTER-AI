import { z } from "zod";

/**
 * Normalized records (ARCHITECTURE §8.1). Adapters translate provider payloads into these; the one
 * ingest service upserts them through ExternalRef, so domain modules never know the provider.
 * Ingest Zod-parses every record again: an adapter mapping bug becomes a plain-words rejection
 * for that record, never a bad row.
 */
const externalId = z.string().trim().min(1, "has no id").max(200);
const optionalText = z
  .string()
  .trim()
  .max(500)
  .transform((v) => (v === "" ? undefined : v))
  .optional()
  .nullable()
  .transform((v) => v ?? undefined);
const email = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "has an email address that is not valid");
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) =>
    v
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, ""),
  )
  .pipe(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "has a domain that is not valid"));
const currency = z
  .string()
  .trim()
  .length(3, "has a currency that is not a 3-letter code")
  .transform((v) => v.toUpperCase());
/** Minor units as an integer (providers send numbers or numeric strings). */
const minor = z.union([z.number().int(), z.string().regex(/^-?\d+$/)]).transform((v) => BigInt(v));
const date = z.coerce.date();

export const normalizedOwner = z.object({
  externalId,
  email: email.optional(),
  name: optionalText,
});

export const normalizedAccount = z.object({
  externalId,
  name: z.string().trim().min(1, "has no name").max(300),
  domain: domain.optional(),
  ownerExternalId: optionalText,
  industry: optionalText,
  employeeBand: optionalText,
  plan: optionalText,
  timezone: optionalText,
  /** Archived/deleted at the provider: the mapping is kept, the account is not touched (D-84). */
  archived: z.boolean().default(false),
});

/** A billing customer (Stripe/Chargebee) is matched to an existing account, never guessed. */
export const normalizedBillingCustomer = z.object({
  externalId,
  name: optionalText,
  email: email.optional(),
  domain: domain.optional(),
  deleted: z.boolean().default(false),
});

export const normalizedContact = z.object({
  externalId,
  accountExternalId: optionalText,
  name: z.string().trim().min(1, "has no name").max(300),
  email: email.optional(),
  title: optionalText,
  archived: z.boolean().default(false),
});

export const normalizedSubscription = z.object({
  externalId,
  customerExternalId: externalId,
  plan: z.string().trim().min(1, "has no plan").max(200),
  interval: z.enum(["MONTH", "YEAR"]),
  amountMinor: minor,
  currency,
  quantity: z.number().int().min(0).default(1),
  status: z.enum(["ACTIVE", "PAST_DUE", "CANCELLED", "ENDED"]),
  currentPeriodEnd: date.optional(),
});

export const normalizedInvoice = z.object({
  externalId,
  customerExternalId: externalId,
  subscriptionExternalId: optionalText,
  number: z.string().trim().min(1, "has no invoice number").max(100),
  amountMinor: minor,
  currency,
  issuedAt: date,
  dueAt: date,
  paidAt: date.optional(),
  status: z.enum(["OPEN", "PAID", "FAILED", "VOID", "UNCOLLECTIBLE"]),
  failureCount: z.number().int().min(0).default(0),
  lastFailedAt: date.optional(),
});

export const normalizedContract = z.object({
  externalId,
  accountExternalId: externalId,
  startDate: date,
  endDate: date.optional(),
  renewalDate: date.optional(),
  /** Null/absent = value not on file (never treated as 0, Rule 4). */
  valueMinor: minor.optional(),
  currency,
  status: z.enum(["ACTIVE", "ENDED", "CANCELLED"]).default("ACTIVE"),
});

const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "has a date that is not YYYY-MM-DD");
const count = z.number().int().min(0).max(1_000_000_000);

/**
 * One account's product usage on one calendar day, with the people and features behind it
 * (spec §6B, D-23: daily aggregates only). `SET` days arrive complete from an analytics tool
 * (Mixpanel, Amplitude): replaying one changes nothing. `ADD` days are increments from the Usage
 * API's aggregation job and are applied once per batch (UsageIngestBatch).
 */
export const normalizedUsageDay = z.object({
  /** The customer's own id for the account (a group id); matched, never created. */
  accountExternalId: externalId,
  date: calendarDay,
  mode: z.enum(["SET", "ADD"]).default("SET"),
  events: count.default(0),
  sessions: count.default(0),
  /** Absent = the number of people listed (ADD: people seen that day so far). */
  activeUsers: count.optional(),
  users: z
    .array(
      z.object({
        externalUserId: externalId,
        email: email.optional(),
        events: count,
        sessions: count.default(0),
      }),
    )
    .max(5000)
    .default([]),
  features: z
    .array(
      z.object({
        featureKey: z.string().trim().min(1).max(100),
        users: count,
        events: count,
      }),
    )
    .max(500)
    .default([]),
});

export const normalizedTicketMessage = z.object({
  externalId,
  direction: z.enum(["INBOUND", "OUTBOUND"]).default("INBOUND"),
  fromAddress: email.optional(),
  fromName: optionalText,
  toAddresses: z.array(email).default([]),
  bodyText: z.string().trim().min(1, "has no text"),
  sentAt: date,
});

export const normalizedTicket = z.object({
  externalId,
  subject: z.string().trim().min(1, "has no subject").max(500),
  status: z.enum(["OPEN", "PENDING", "SOLVED", "CLOSED"]).default("OPEN"),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
  requesterEmail: email.optional(),
  requesterName: optionalText,
  /** Why there is no requesterEmail, when the provider could not give one (shown, never guessed). */
  requesterUnresolvedReason: z.string().trim().min(1).max(500).optional(),
  openedAt: date,
  updatedAt: date.optional(),
  closedAt: date.optional(),
  messages: z.array(normalizedTicketMessage).default([]),
});

export const normalizedMail = z.object({
  externalId,
  threadExternalId: optionalText,
  direction: z.enum(["INBOUND", "OUTBOUND"]).default("INBOUND"),
  fromAddress: email,
  fromName: optionalText,
  toAddresses: z.array(email).min(1, "has no recipients"),
  subject: z.string().trim().max(500).default(""),
  bodyText: z.string().trim().min(1, "has no body"),
  sentAt: date,
});

export const normalizedMeetingAttendee = z.object({
  email,
  name: optionalText,
  responseStatus: z
    .enum(["NEEDS_ACTION", "ACCEPTED", "DECLINED", "TENTATIVE"])
    .default("NEEDS_ACTION"),
});

export const normalizedMeeting = z.object({
  externalId,
  title: z.string().trim().min(1, "has no title").max(500),
  startsAt: date,
  endsAt: date,
  organizerEmail: email.optional(),
  accountExternalId: externalId.optional(),
  attendees: z.array(normalizedMeetingAttendee).default([]),
  status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED"]).default("SCHEDULED"),
});

export const normalizedTranscript = z.object({
  externalId,
  title: z.string().trim().min(1, "has no title").max(500),
  occurredAt: date,
  text: z.string().trim().min(1, "has no text"),
  language: z.string().trim().default("en"),
  segments: z.unknown().optional(),
  durationSec: z.number().int().nonnegative().optional(),
  accountExternalId: externalId.optional(),
  meetingExternalId: externalId.optional(),
  attendeeEmails: z.array(email).default([]),
});

export type NormalizedOwner = z.infer<typeof normalizedOwner>;
export type NormalizedAccount = z.infer<typeof normalizedAccount>;
export type NormalizedBillingCustomer = z.infer<typeof normalizedBillingCustomer>;
export type NormalizedContact = z.infer<typeof normalizedContact>;
export type NormalizedSubscription = z.infer<typeof normalizedSubscription>;
export type NormalizedInvoice = z.infer<typeof normalizedInvoice>;
export type NormalizedContract = z.infer<typeof normalizedContract>;
export type NormalizedUsageDay = z.infer<typeof normalizedUsageDay>;
export type NormalizedTicketMessage = z.infer<typeof normalizedTicketMessage>;
export type NormalizedTicket = z.infer<typeof normalizedTicket>;
export type NormalizedMail = z.infer<typeof normalizedMail>;
export type NormalizedMeetingAttendee = z.infer<typeof normalizedMeetingAttendee>;
export type NormalizedMeeting = z.infer<typeof normalizedMeeting>;
export type NormalizedTranscript = z.infer<typeof normalizedTranscript>;

export const NORMALIZED = {
  owners: normalizedOwner,
  accounts: normalizedAccount,
  customers: normalizedBillingCustomer,
  contacts: normalizedContact,
  subscriptions: normalizedSubscription,
  invoices: normalizedInvoice,
  contracts: normalizedContract,
  usage: normalizedUsageDay,
  tickets: normalizedTicket,
  mail: normalizedMail,
  meetings: normalizedMeeting,
  transcripts: normalizedTranscript,
} as const;

export type NormalizedKind = keyof typeof NORMALIZED;

/**
 * One page from an adapter. `records` are the adapter's mapped objects, typed `unknown` on purpose:
 * ingest validates each one against NORMALIZED[kind] and rejects bad ones by themselves.
 */
export interface NormalizedBatch {
  kind: NormalizedKind;
  records: unknown[];
  /** Provider cursor after this page; persisted only when the whole run succeeds. */
  cursor?: string;
  /**
   * `usage` batches from the Usage API: the batch's key in UsageIngestBatch. A batch whose key is
   * already there is skipped whole (a replay changes nothing).
   */
  ledgerKey?: string;
  /** With `ledgerKey`: how many raw events the batch held (recorded as a count, never the events). */
  ledgerEvents?: number;
}

/** A webhook turned into data plus, optionally, a reason to evaluate one account now (§5.2). */
export interface NormalizedEvent {
  externalEventId: string;
  type: string;
  batches: NormalizedBatch[];
  /** Billing customer whose account should be re-evaluated in real time. */
  realtimeCustomerExternalId?: string;
}
