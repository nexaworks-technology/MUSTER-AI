/**
 * CSV import templates (spec §6B "CSV import", ARCHITECTURE §8.3). Each template lists its
 * columns, which are required, and the key that makes re-imports idempotent (D-47).
 */
export type ImportKind =
  | "ACCOUNTS"
  | "CONTACTS"
  | "CONTRACTS"
  | "INVOICES"
  | "USAGE_ACCOUNT_DAILY"
  | "USAGE_USER_DAILY"
  | "USAGE_FEATURE_DAILY"
  | "TICKETS"
  | "TICKET_MESSAGES";

export type FieldType =
  | { type: "text"; max: number }
  | { type: "email" }
  | { type: "date" }
  | { type: "datetime" }
  | { type: "int" }
  | { type: "money" }
  | { type: "currency" }
  | { type: "bool" }
  | { type: "enum"; values: Record<string, string> };

export interface TemplateField {
  key: string;
  label: string;
  required: boolean;
  spec: FieldType;
  example: string;
}

export interface ImportTemplate {
  kind: ImportKind;
  slug: string;
  title: string;
  description: string;
  /** How a row is recognised again on re-import. */
  dedupe: string;
  fields: TemplateField[];
  /** At least one of these must be filled (e.g. account_id or account_domain). */
  oneOf?: [string, string];
}

const text = (max = 200): FieldType => ({ type: "text", max });
const f = (
  key: string,
  label: string,
  required: boolean,
  spec: FieldType,
  example: string,
): TemplateField => ({ key, label, required, spec, example });

const TIER = {
  type: "enum",
  values: {
    "high-touch": "HIGH_TOUCH",
    high: "HIGH_TOUCH",
    "mid-touch": "MID_TOUCH",
    mid: "MID_TOUCH",
    "long-tail": "LONG_TAIL",
    long: "LONG_TAIL",
  },
} as const;
const STAGE = {
  type: "enum",
  values: {
    onboarding: "ONBOARDING",
    adopting: "ADOPTING",
    mature: "MATURE",
    renewing: "RENEWING",
    lost: "LOST",
  },
} as const;
const ROLE = {
  type: "enum",
  values: {
    champion: "CHAMPION",
    "decision maker": "DECISION_MAKER",
    "daily user": "DAILY_USER",
    "executive sponsor": "EXEC_SPONSOR",
    billing: "BILLING",
    other: "OTHER",
  },
} as const;
const ACCOUNT_REF = [
  f("account_id", "Account ID", false, text(100), "ACME-1"),
  f("account_domain", "Account domain", false, text(200), "acme.test"),
];

export const TEMPLATES: Record<ImportKind, ImportTemplate> = {
  ACCOUNTS: {
    kind: "ACCOUNTS",
    slug: "accounts",
    title: "Accounts",
    dedupe: "account_id",
    description:
      "One row per customer account. Tier is re-derived from ARR once a contract is imported, unless you set it here.",
    fields: [
      f("account_id", "Account ID", true, text(100), "ACME-1"),
      f("name", "Name", true, text(200), "Acme Freight"),
      f("tier", "Tier", true, TIER, "Mid-touch"),
      f("domain", "Domain", false, text(200), "acme-freight.test"),
      f("stage", "Stage", false, STAGE, "Adopting"),
      f("owner_email", "Owner email", false, { type: "email" }, "leo@larkspur.test"),
      f("plan", "Plan", false, text(60), "Growth"),
      f("industry", "Industry", false, text(80), "Logistics"),
      f("employee_band", "Company size", false, text(20), "51-200"),
      f("onboarding_started", "Onboarding started", false, { type: "date" }, "2026-10-01"),
    ],
  },
  CONTACTS: {
    kind: "CONTACTS",
    slug: "contacts",
    title: "Contacts",
    dedupe: "contact_id, or the email address when there is no contact_id",
    description:
      "People at your accounts. Use account_id (from your accounts file) or the account's domain.",
    oneOf: ["account_id", "account_domain"],
    fields: [
      f("contact_id", "Contact ID", false, text(100), "C-100"),
      ...ACCOUNT_REF,
      f("email", "Email", true, { type: "email" }, "pat@acme-freight.test"),
      f("name", "Name", true, text(200), "Pat Lee"),
      f("title", "Title", false, text(120), "Head of Operations"),
      f("role", "Role", false, ROLE, "Champion"),
      f(
        "status",
        "Status",
        false,
        { type: "enum", values: { active: "ACTIVE", bounced: "BOUNCED", left: "LEFT" } },
        "Active",
      ),
    ],
  },
  CONTRACTS: {
    kind: "CONTRACTS",
    slug: "contracts",
    title: "Contracts",
    dedupe: "contract_id",
    description: "One row per contract (amounts in whole currency units, e.g. 36000.00).",
    oneOf: ["account_id", "account_domain"],
    fields: [
      f("contract_id", "Contract ID", true, text(100), "K-2026-01"),
      ...ACCOUNT_REF,
      f("start_date", "Start date", true, { type: "date" }, "2026-01-01"),
      f("end_date", "End date", false, { type: "date" }, "2026-12-31"),
      f("renewal_date", "Renewal date", false, { type: "date" }, "2027-01-01"),
      f("value", "Annual value", false, { type: "money" }, "36000.00"),
      f("currency", "Currency", false, { type: "currency" }, "USD"),
      f("seats", "Seats bought", false, { type: "int" }, "40"),
      f("notice_days", "Notice period (days)", false, { type: "int" }, "60"),
      f("auto_renew", "Auto-renews", false, { type: "bool" }, "yes"),
      f(
        "status",
        "Status",
        false,
        { type: "enum", values: { active: "ACTIVE", ended: "ENDED", cancelled: "CANCELLED" } },
        "Active",
      ),
    ],
  },
  INVOICES: {
    kind: "INVOICES",
    slug: "invoices",
    title: "Invoices",
    dedupe: "invoice_number",
    description: "Invoices and whether they were paid.",
    oneOf: ["account_id", "account_domain"],
    fields: [
      f("invoice_number", "Invoice number", true, text(60), "INV-1001"),
      ...ACCOUNT_REF,
      f("amount", "Amount", true, { type: "money" }, "3000.00"),
      f("currency", "Currency", false, { type: "currency" }, "USD"),
      f("issued_date", "Issued", true, { type: "date" }, "2026-10-01"),
      f("due_date", "Due", true, { type: "date" }, "2026-10-31"),
      f("paid_date", "Paid", false, { type: "date" }, "2026-10-20"),
      f(
        "status",
        "Status",
        false,
        {
          type: "enum",
          values: {
            open: "OPEN",
            paid: "PAID",
            failed: "FAILED",
            void: "VOID",
            uncollectible: "UNCOLLECTIBLE",
          },
        },
        "Paid",
      ),
    ],
  },
  USAGE_ACCOUNT_DAILY: {
    kind: "USAGE_ACCOUNT_DAILY",
    slug: "usage-account-daily",
    title: "Usage per account per day",
    dedupe: "account + date",
    description: "Daily active users and activity for each account.",
    oneOf: ["account_id", "account_domain"],
    fields: [
      ...ACCOUNT_REF,
      f("date", "Date", true, { type: "date" }, "2026-10-31"),
      f("active_users", "Active users", true, { type: "int" }, "12"),
      f("sessions", "Sessions", false, { type: "int" }, "20"),
      f("events", "Events", false, { type: "int" }, "340"),
      f("seats_used", "Seats used", false, { type: "int" }, "15"),
    ],
  },
  USAGE_USER_DAILY: {
    kind: "USAGE_USER_DAILY",
    slug: "usage-user-daily",
    title: "Usage per person per day",
    dedupe: "account + user_id + date",
    description: "Activity per person, linked to a contact when the email matches.",
    oneOf: ["account_id", "account_domain"],
    fields: [
      ...ACCOUNT_REF,
      f("user_id", "User ID", true, text(120), "u-17"),
      f("date", "Date", true, { type: "date" }, "2026-10-31"),
      f("events", "Events", true, { type: "int" }, "40"),
      f("sessions", "Sessions", false, { type: "int" }, "2"),
      f("contact_email", "Contact email", false, { type: "email" }, "pat@acme-freight.test"),
    ],
  },
  USAGE_FEATURE_DAILY: {
    kind: "USAGE_FEATURE_DAILY",
    slug: "usage-feature-daily",
    title: "Usage per feature per day",
    dedupe: "account + feature_key + date",
    description: "How many people used each feature each day.",
    oneOf: ["account_id", "account_domain"],
    fields: [
      ...ACCOUNT_REF,
      f("feature_key", "Feature key", true, text(60), "dashboards"),
      f("date", "Date", true, { type: "date" }, "2026-10-31"),
      f("users", "Users", true, { type: "int" }, "8"),
      f("events", "Events", false, { type: "int" }, "52"),
    ],
  },
  TICKETS: {
    kind: "TICKETS",
    slug: "tickets",
    title: "Support tickets",
    dedupe: "ticket_id",
    description: "Support tickets. Import their messages with the ticket messages template.",
    oneOf: ["account_id", "account_domain"],
    fields: [
      f("ticket_id", "Ticket ID", true, text(100), "T-5001"),
      ...ACCOUNT_REF,
      f("subject", "Subject", true, text(300), "Export fails at month-end"),
      f("opened_at", "Opened", true, { type: "datetime" }, "2026-10-28T15:00:00Z"),
      f("closed_at", "Closed", false, { type: "datetime" }, ""),
      f(
        "status",
        "Status",
        false,
        {
          type: "enum",
          values: { open: "OPEN", pending: "PENDING", solved: "SOLVED", closed: "CLOSED" },
        },
        "Open",
      ),
      f(
        "priority",
        "Priority",
        false,
        { type: "enum", values: { low: "LOW", normal: "NORMAL", high: "HIGH", urgent: "URGENT" } },
        "High",
      ),
      f("escalated", "Escalated", false, { type: "bool" }, "no"),
      f("contact_email", "Requester email", false, { type: "email" }, "pat@acme-freight.test"),
    ],
  },
  TICKET_MESSAGES: {
    kind: "TICKET_MESSAGES",
    slug: "ticket-messages",
    title: "Ticket messages",
    dedupe: "message_id",
    description: "The messages on tickets you have already imported.",
    fields: [
      f("message_id", "Message ID", true, text(100), "M-9001"),
      f("ticket_id", "Ticket ID", true, text(100), "T-5001"),
      f("sent_at", "Sent", true, { type: "datetime" }, "2026-10-28T15:00:00Z"),
      f(
        "direction",
        "Direction",
        true,
        {
          type: "enum",
          values: {
            inbound: "INBOUND",
            customer: "INBOUND",
            outbound: "OUTBOUND",
            agent: "OUTBOUND",
          },
        },
        "Inbound",
      ),
      f("body", "Message", true, text(20_000), "The export failed again."),
      f("from_email", "From email", false, { type: "email" }, "pat@acme-freight.test"),
    ],
  },
};

export const templateBySlug = (slug: string) =>
  Object.values(TEMPLATES).find((t) => t.slug === slug) ?? null;

/** The downloadable template: header row plus one example row. */
export function templateCsv(t: ImportTemplate): string {
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `${t.fields.map((x) => x.key).join(",")}\n${t.fields.map((x) => quote(x.example)).join(",")}\n`;
}
