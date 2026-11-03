import type { IntegrationProvider } from "@prisma/client";
import type { IntegrationAdapter } from "../adapter";
import { chargebeeAdapter } from "./chargebee";
import { hubspotAdapter } from "./hubspot";
import { salesforceAdapter } from "./salesforce";
import { stripeAdapter } from "./stripe";

/**
 * Adapter registry. Each launch connector registers here once it has fixtures and contract tests
 * (M5 build order: Stripe, HubSpot in Session A; Salesforce, Chargebee, Slack in Session B).
 */
// Adapters differ in their config type; the registry stores them erased (callers parse config
// with each adapter's own configSchema before use).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdapter = IntegrationAdapter<any>;

export const ADAPTERS: Partial<Record<IntegrationProvider, AnyAdapter>> = {
  HUBSPOT: hubspotAdapter,
  SALESFORCE: salesforceAdapter,
  STRIPE: stripeAdapter,
  CHARGEBEE: chargebeeAdapter,
};

export class AdapterMissingError extends Error {
  constructor(provider: IntegrationProvider) {
    super(`No adapter is registered for ${provider}`);
    this.name = "AdapterMissingError";
  }
}

export function adapterFor(provider: IntegrationProvider): AnyAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new AdapterMissingError(provider);
  return adapter;
}
