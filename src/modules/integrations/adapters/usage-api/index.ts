import { z } from "zod";
import type { IntegrationAdapter } from "../../adapter";
import { describeProviderError } from "../../errors";

/**
 * The Usage API as a connector card (M6 B1). It pulls nothing: customers push events to
 * `/api/usage/v1/*` with the integration's ingest key, or through Segment's webhook destination
 * signed with its shared secret. This registration gives it a place in Settings › Integrations
 * and the framework's status, error and disconnect handling; the intake lives in `usage-api/`.
 */
type Cfg = Record<string, never>;

export const usageApiAdapter: IntegrationAdapter<Cfg> = {
  provider: "USAGE_API",
  category: "USAGE",
  displayName: "Usage API",
  configSchema: z.object({}).strip() as unknown as z.ZodType<Cfg>,
  auth: {
    kind: "apiKey",
    async validate() {
      // The key is generated here, not pasted from a provider: there is nothing to check.
    },
  },
  async testConnection() {
    return {
      ok: true,
      message: "The Usage API accepts events sent with your key. Check the last batch below.",
    };
  },
  async *sync() {
    return;
  },
  describeError: (err) => describeProviderError(err, "The Usage API", "Generate a new key."),
};
