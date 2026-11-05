import type { IntegrationProvider } from "@prisma/client";
import type { IntegrationAdapter } from "../adapter";
import { chargebeeAdapter } from "./chargebee";
import { amplitudeAdapter } from "./amplitude";
import { hubspotAdapter } from "./hubspot";
import { mixpanelAdapter } from "./mixpanel";
import { salesforceAdapter } from "./salesforce";
import { slackAdapter } from "./slack";
import { stripeAdapter } from "./stripe";
import { usageApiAdapter } from "./usage-api";
import { zendeskAdapter } from "./zendesk";
import { freshdeskAdapter } from "./freshdesk";
import { googleEmailAdapter } from "./google-email";
import { microsoftEmailAdapter } from "./microsoft-email";
import { googleCalendarAdapter } from "./google-calendar";
import { microsoftCalendarAdapter } from "./microsoft-calendar";
import { firefliesAdapter } from "./fireflies";
import { gongAdapter } from "./gong";
import { zoomAdapter } from "./zoom";

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
  SLACK: slackAdapter,
  USAGE_API: usageApiAdapter,
  MIXPANEL: mixpanelAdapter,
  AMPLITUDE: amplitudeAdapter,
  ZENDESK: zendeskAdapter,
  FRESHDESK: freshdeskAdapter,
  GOOGLE_EMAIL: googleEmailAdapter,
  MICROSOFT_EMAIL: microsoftEmailAdapter,
  GOOGLE_CALENDAR: googleCalendarAdapter,
  MICROSOFT_CALENDAR: microsoftCalendarAdapter,
  FIREFLIES: firefliesAdapter,
  GONG: gongAdapter,
  ZOOM: zoomAdapter,
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
