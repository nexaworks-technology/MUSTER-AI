/**
 * The fixed list of pilot instrumentation events (M12 B5, spec §11). Names only; capture lives in
 * pilot-capture.ts and the arithmetic in pilot-metrics.ts. Props carry ids and small enums, never
 * customer content.
 */
export const PRODUCT_EVENT_NAMES = [
  "today.opened",
  "approvals.opened",
  "approval.decided",
  "signal.flag_accepted",
  "signal.false_alarm",
  "brief.generated",
  "brief.shared",
  "qbr.generated",
  "qbr.shared",
] as const;
export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

/** Page views are recorded at most once per member per page per this many minutes. */
export const PAGE_VIEW_DEDUPE_MINUTES = 30;
export const PAGE_VIEW_EVENTS: readonly ProductEventName[] = ["today.opened", "approvals.opened"];

export const isProductEventName = (n: string): n is ProductEventName =>
  (PRODUCT_EVENT_NAMES as readonly string[]).includes(n);
