import type { IntegrationProvider, RecordSource } from "@prisma/client";

/** Display names and the RecordSource each data provider writes (ARCHITECTURE §3.1). */
export const PROVIDER_NAMES: Record<IntegrationProvider, string> = {
  HUBSPOT: "HubSpot",
  SALESFORCE: "Salesforce",
  STRIPE: "Stripe",
  CHARGEBEE: "Chargebee",
  SLACK: "Slack",
};

export const SOURCE_NAMES: Partial<Record<RecordSource, string>> = {
  HUBSPOT: "HubSpot",
  SALESFORCE: "Salesforce",
  STRIPE: "Stripe",
  CHARGEBEE: "Chargebee",
  CSV: "a CSV import",
  MANUAL: "a person",
  SEED: "the demo data",
  SYSTEM: "the system",
};

export const CRM_PROVIDERS = ["HUBSPOT", "SALESFORCE"] as const;

/** Slack writes no records, so it has no source. */
export function recordSourceFor(provider: IntegrationProvider): RecordSource | null {
  return provider === "SLACK" ? null : provider;
}
