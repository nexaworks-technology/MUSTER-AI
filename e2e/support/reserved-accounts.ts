/**
 * M12 B7 — e2e isolation. Accounts whose state an e2e spec CHANGES for good (append-only
 * outcomes, enrolments, sent approvals). Each belongs to exactly one spec, so no two specs can
 * race on or pre-empt each other's records, whatever order or workers they run in. A new spec
 * that mutates an account adds it here; `reserved-accounts.test.ts` refuses a double booking and
 * an entry whose spec no longer names the account.
 */
export type Reservation = {
  account: string;
  /** The spec that owns the account. */
  spec: string;
  /** Files that must name the account (the spec, or the support helper it calls). */
  namedIn: string[];
  why: string;
};

export const RESERVED_ACCOUNTS: readonly Reservation[] = [
  {
    account: "Oakcrest Couriers",
    spec: "e2e/m7-renewals-revenue.spec.ts",
    namedIn: ["e2e/m7-renewals-revenue.spec.ts"],
    why: "records a RENEWED outcome (append-only) through the contract records",
  },
  {
    account: "Northbrook Fabrication",
    spec: "e2e/m11-ask-ledger.spec.ts",
    namedIn: ["e2e/support/m11.ts"],
    why: "live save chain: rules flag, approval + send, renewal sync, frozen checkpoints",
  },
  {
    account: "Northgate Freight",
    spec: "e2e/m11-ask-ledger.spec.ts",
    namedIn: ["e2e/m11-ask-ledger.spec.ts"],
    why: "Ask AI move request enrols it in the Renewal Risk play",
  },
  {
    account: "Brightwell Logistics",
    spec: "e2e/m11-ask-ledger.spec.ts",
    namedIn: ["e2e/m11-ask-ledger.spec.ts"],
    why: "Ask AI move request enrols it in the Renewal Risk play",
  },
];
