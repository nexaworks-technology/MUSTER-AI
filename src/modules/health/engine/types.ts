import type { CalendarDate } from "@/lib/dates";
import type { Curve } from "./curves";
import type { ModelParams, Pillar } from "./model";

/**
 * The engine's input: everything one account's score may read, already cut to the as-of date by
 * the loader (and cut again by the engine, as a second guard against look-ahead). Moments are
 * converted to workspace-local calendar dates by the loader (D-50, M3 rule 7).
 */
export type Tier = "HIGH_TOUCH" | "MID_TOUCH" | "LONG_TAIL";
export type ContactStatus = "ACTIVE" | "BOUNCED" | "LEFT" | "UNKNOWN";
export type RoleType =
  "CHAMPION" | "DECISION_MAKER" | "DAILY_USER" | "EXEC_SPONSOR" | "BILLING" | "OTHER";

/** A pointer to the exact record(s) behind a reason: one row, or a window of rows. */
export interface SourceRef {
  sourceType: string;
  sourceId?: string;
  accountId?: string;
  from?: CalendarDate;
  to?: CalendarDate;
}

export interface ReasonDraft {
  component: string;
  kind: "EVIDENCE" | "MISSING_DATA";
  message: string;
  input: string;
  value?: number | null;
  baseline?: number | null;
  delta?: number | null;
  cohortValue?: number | null;
  cohortKey?: string | null;
  cohortSize?: number | null;
  periodStart?: CalendarDate | null;
  periodEnd?: CalendarDate | null;
  sources: SourceRef[];
  /** Set by the Pulse component only. */
  pulseValue?: "FINE" | "WORRIED";
}

export interface ComponentResult {
  score: number | null;
  reason: ReasonDraft;
}

export interface OwnBaseline {
  /** Median / 25th percentile of the weekly metric over [asOf−104, asOf−14]. */
  median: number | null;
  p25: number | null;
  /** Days with usage data inside that window. */
  historyDays: number;
  from: CalendarDate;
  to: CalendarDate;
}

export interface CohortBaseline {
  key: string;
  /** "Mid-touch accounts on the Growth plan with 51-200 employees" */
  label: string;
  /** Peers (the account itself excluded). */
  size: number;
  /** Median active rate (typical weekday active users ÷ seats bought) among peers. */
  medianRate: number | null;
}

export interface AccountBundle {
  accountId: string;
  asOf: CalendarDate;
  /** Tier as of the date (rebuilt from ARR then, unless set by hand; D-56). */
  tier: Tier;
  plan: string | null;
  employeeBand: string | null;
  useCase: string | null;
  /** null = no usage data source for this account at all. */
  usage: Array<{
    id: string;
    date: CalendarDate;
    activeUsers: number;
    seatsUsed: number | null;
  }> | null;
  ownBaseline: OwnBaseline | null;
  cohort: CohortBaseline | null;
  /** null = no per-user usage data. */
  userUsage: Array<{
    externalUserId: string;
    contactId: string | null;
    name: string | null;
    date: CalendarDate;
    events: number;
  }> | null;
  /** null = no per-feature usage data. */
  featureUsage: Array<{ featureKey: string; date: CalendarDate; users: number }> | null;
  /** Key features included in the account's plan. */
  keyFeatures: Array<{ featureKey: string; label: string }>;
  /** The contract active on the as-of date. */
  contract: {
    id: string;
    seatsPurchased: number | null;
    startDate: CalendarDate;
    renewalDate: CalendarDate | null;
  } | null;
  /** null = no messages at all (no conversation data source). */
  messages: Array<{
    id: string;
    conversationId: string;
    channel: "EMAIL" | "CHAT" | "CALL" | "MEETING" | "TICKET" | "NOTE";
    direction: "INBOUND" | "OUTBOUND";
    date: CalendarDate;
    fromContactId: string | null;
    isBounce: boolean;
    /**
     * An AI label written only after its verbatim quote was verified against this message (M4,
     * D-75): data, never a score. Absent when the message has no label.
     */
    sentimentLabel?: "NEGATIVE" | "NEUTRAL" | "POSITIVE" | "MIXED";
  }> | null;
  /** False when the workspace has no ticket data at all (Support then has no data). */
  workspaceHasTickets: boolean;
  tickets: Array<{
    id: string;
    subject: string;
    priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
    openedDate: CalendarDate;
    closedDate: CalendarDate | null;
    escalatedDate: CalendarDate | null;
  }>;
  contacts: Array<{
    id: string;
    name: string;
    status: ContactStatus;
    /** When the status became true (statusChangedAt, else the row's createdAt; D-56). */
    statusDate: CalendarDate | null;
  }>;
  roles: Array<{
    id: string;
    contactId: string;
    role: RoleType;
    validFrom: CalendarDate;
    validTo: CalendarDate | null;
  }>;
  invoices: Array<{
    id: string;
    number: string;
    issuedDate: CalendarDate;
    dueDate: CalendarDate;
    paidDate: CalendarDate | null;
    failedDate: CalendarDate | null;
    isVoid: boolean;
  }>;
  revenueEvents: Array<{
    id: string;
    type: "NEW" | "EXPANSION" | "CONTRACTION" | "CHURN" | "REACTIVATION";
    deltaArrMinor: number;
    effectiveDate: CalendarDate;
  }>;
  pulse: {
    id: string;
    value: "FINE" | "WORRIED";
    authorName: string;
    comment: string | null;
    createdDate: CalendarDate;
    expiresDate: CalendarDate;
  } | null;
}

/** What a component may read besides the bundle: its curve and the model's fixed params. */
export interface ComponentEnv {
  curve?: Curve;
  params: ModelParams;
}

export type ComponentFn = (b: AccountBundle, env: ComponentEnv) => ComponentResult;
export type PillarComponents = Record<string, ComponentFn>;
export type { Pillar };
