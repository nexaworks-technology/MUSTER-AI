import type { IntegrationProvider, RecordSource } from "@prisma/client";

/** Display names and the RecordSource each data provider writes (ARCHITECTURE §3.1). */
export const PROVIDER_NAMES: Record<IntegrationProvider, string> = {
  HUBSPOT: "HubSpot",
  SALESFORCE: "Salesforce",
  STRIPE: "Stripe",
  CHARGEBEE: "Chargebee",
  SLACK: "Slack",
  USAGE_API: "Usage API",
  MIXPANEL: "Mixpanel",
  AMPLITUDE: "Amplitude",
  ZENDESK: "Zendesk",
  FRESHDESK: "Freshdesk",
  GOOGLE_EMAIL: "Gmail",
  MICROSOFT_EMAIL: "Outlook",
};

export const SOURCE_NAMES: Partial<Record<RecordSource, string>> = {
  HUBSPOT: "HubSpot",
  SALESFORCE: "Salesforce",
  STRIPE: "Stripe",
  CHARGEBEE: "Chargebee",
  USAGE_API: "the Usage API",
  MIXPANEL: "Mixpanel",
  AMPLITUDE: "Amplitude",
  ZENDESK: "Zendesk",
  FRESHDESK: "Freshdesk",
  GMAIL: "Gmail",
  MICROSOFT_EMAIL: "Outlook",
  CSV: "a CSV import",
  MANUAL: "a person",
  SEED: "the demo data",
  SYSTEM: "the system",
};

export const CRM_PROVIDERS = ["HUBSPOT", "SALESFORCE"] as const;

export type ProviderSource = Exclude<RecordSource, "CSV" | "MANUAL" | "SEED" | "SYSTEM">;

/** Gmail's provider key differs from its source key; every other provider writes its own name. */
const SOURCE_OF: Partial<Record<IntegrationProvider, ProviderSource>> = { GOOGLE_EMAIL: "GMAIL" };

/** Slack writes no records, so it has no source. */
export function recordSourceFor(provider: IntegrationProvider): ProviderSource | null {
  if (provider === "SLACK") return null;
  return SOURCE_OF[provider] ?? (provider as ProviderSource);
}
