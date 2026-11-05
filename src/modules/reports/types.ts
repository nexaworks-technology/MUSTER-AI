import type { CalendarDate } from "@/lib/dates";

/**
 * The shape every pre-made report shares (M11 rule 3). A report is a list of sections of
 * figures; each figure carries the records it was computed from, so nothing is a naked number
 * (Rule 1). A figure with no data says so (`value: null` + `reason`), never 0 (Rule 4).
 * Money figures are `unit: "money"` (value = minor units as a decimal string, plus currency) so
 * redaction can find and replace every one of them at read time.
 */
export const REPORT_KEYS = [
  "portfolio-health-trend",
  "adoption",
  "onboarding-ttv",
  "renewal-outcomes",
  "expansion-found",
  "support-risk",
  "team-activity",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export const REPORT_TITLES: Record<ReportKey, { title: string; description: string }> = {
  "portfolio-health-trend": {
    title: "Portfolio health trend",
    description: "How many accounts sit in each health band over time, and who moved.",
  },
  adoption: {
    title: "Adoption",
    description: "Seats and features in use against what was bought, across accounts.",
  },
  "onboarding-ttv": {
    title: "Onboarding time to value",
    description: "How long new accounts take to reach value, and who is late.",
  },
  "renewal-outcomes": {
    title: "Renewal outcomes",
    description: "What happened to renewals in the period, against the forecast made before.",
  },
  "expansion-found": {
    title: "Expansion found",
    description: "Expansion opportunities found in the period and where they stand.",
  },
  "support-risk": {
    title: "Support risk",
    description: "Open, escalated and slow support tickets and the support signals behind them.",
  },
  "team-activity": {
    title: "Team activity vs outcomes",
    description: "What each owner did in the period, next to what happened to their flags.",
  },
};

export const isReportKey = (k: string): k is ReportKey =>
  (REPORT_KEYS as readonly string[]).includes(k);

export type FigureUnit = "count" | "percent" | "days" | "hours" | "money";

/** One record a figure can be traced to, with the page it lives on. */
export interface SourceLink {
  id: string;
  href: string;
  label?: string;
}

export interface FigureSources {
  type: string;
  ids: string[];
  /** Pages for the first records (capped); the full id list stays in `ids`. */
  links?: SourceLink[];
}

export interface Figure {
  label: string;
  /** Money: minor units as a decimal string. Null = no data (see `reason`). */
  value: number | string | null;
  unit: FigureUnit;
  sources: FigureSources;
  /** The existing screen that lists these records, when one filters to them. */
  href?: string;
  reason?: string;
  /** Money only. */
  currency?: string | null;
  /** Set at read time when the viewer may not see money. */
  restricted?: boolean;
}

export interface Section {
  title: string;
  note?: string;
  figures: Figure[];
}

export interface ReportContent {
  sections: Section[];
  /** Plain-language caveats about data the report could not use. */
  notes: string[];
}

export interface ReportData extends ReportContent {
  reportKey: ReportKey;
  periodStart: CalendarDate;
  periodEnd: CalendarDate;
  /** Accounts the report covered (after the viewer's book and the filters). */
  accountsInScope: number;
}

/** Lookups the pure computations need to build hrefs (query strings for list screens). */
export interface LinkContext {
  /** Query string for list screens, e.g. "tier=MID_TOUCH&owner=abc" (no leading "?"). */
  query: string;
}
