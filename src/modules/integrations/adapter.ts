import type { IntegrationProvider } from "@prisma/client";
import type { z } from "zod";
import type { Clock } from "@/lib/dates";
import type { Credentials } from "./credentials";
import type { NormalizedBatch, NormalizedEvent } from "./normalized";
import type { HttpTransport } from "./transport";

/**
 * The adapter interface, as ARCHITECTURE §8.1 defines it. Adding a connector (M6 usage, M9
 * support/email, M10 calls) means one adapter here plus fixtures and contract tests; the sync
 * engine, ingest, webhook route and write-back gate do not change.
 */
export type IntegrationCategory =
  "CRM" | "BILLING" | "SUPPORT" | "USAGE" | "EMAIL" | "CALENDAR" | "CALLS" | "CHAT";

export interface AdapterContext<Cfg> {
  workspaceId: string;
  integrationId: string;
  credentials: Credentials;
  config: Cfg;
  transport: HttpTransport;
  clock: Clock;
  /** The business "now" (D-81): usage connectors date their windows with it. Tests may omit it. */
  businessClock?: Clock;
}

export interface ConnectionCheck {
  ok: boolean;
  /** Plain words for Settings › Integrations. */
  message: string;
  /** The provider's id for the connected account (portal, org, Stripe account, team). */
  externalAccountId?: string;
}

export interface OAuthUrls {
  redirectUri: string;
  state: string;
}

export type AdapterAuth =
  | {
      kind: "oauth2";
      scopes: readonly string[];
      authorizeUrl(urls: OAuthUrls): string;
      exchange(code: string, redirectUri: string, transport: HttpTransport): Promise<Credentials>;
      refresh(credentials: Credentials, transport: HttpTransport): Promise<Credentials>;
    }
  | {
      kind: "apiKey";
      /**
       * Throws ProviderHttpError when the key is refused. `config` is the connection's own
       * settings, already parsed with the adapter's configSchema (e.g. a Mixpanel project id).
       */
      validate(credentials: Credentials, transport: HttpTransport, config?: unknown): Promise<void>;
    };

/** The raw request a webhook route received. Nothing in it is trusted until `verify` passes. */
export interface InboundRequest {
  headers: Record<string, string>;
  rawBody: string;
  url: string;
}

export interface WriteBackField {
  /** Our field name, e.g. "ownerMembershipId". */
  key: string;
  label: string;
}

export interface WriteBackChange {
  field: string;
  accountId: string;
  /** The provider's id for the record being written. */
  externalId: string;
  /** Provider-side value (e.g. a HubSpot owner id). */
  value: string;
  /** M7 B2: the new record to create, for an export field (never set for a field update). */
  record?: ExportRecord;
}

/** What an export creates in the customer's CRM: a deal / opportunity, labelled an estimate. */
export interface ExportRecord {
  name: string;
  description: string;
  /** Major units as a decimal string, or null when there is no estimate (never 0). */
  amount: string | null;
  /** ISO date the CRM needs as a close date. */
  closeDate: string;
}

/** The one export field: a new expansion opportunity in the CRM (M7 B2). */
export const EXPANSION_EXPORT_FIELD = "expansionOpportunity";

export interface IntegrationAdapter<Cfg = Record<string, never>> {
  provider: IntegrationProvider;
  category: IntegrationCategory;
  displayName: string;
  configSchema: z.ZodType<Cfg>;
  auth: AdapterAuth;
  testConnection(ctx: AdapterContext<Cfg>): Promise<ConnectionCheck>;
  sync(
    ctx: AdapterContext<Cfg>,
    opts: { kind: "FULL" | "INCREMENTAL"; cursor?: string },
  ): AsyncIterable<NormalizedBatch>;
  webhook?: {
    /** Constant-time check against this integration's own secret (D3). */
    verify(req: InboundRequest, secret: string, now: Date): boolean;
    toEvents(payload: unknown): NormalizedEvent[];
  };
  /** Only reachable through writeback.service (Rule 7). */
  writeBack?: {
    /** Updates to an existing CRM record (the account owner). */
    fields: readonly WriteBackField[];
    /**
     * New records created in the CRM (M7 B2: an expansion opportunity). Kept apart from `fields`
     * so the update fields stay exactly as M5 declared them; the gate treats both the same way.
     * Resolves with the new record's CRM id for an export.
     */
    exports?: readonly WriteBackField[];
    push(ctx: AdapterContext<Cfg>, change: WriteBackChange): Promise<{ externalId: string } | void>;
  };
  describeError(err: unknown): { plain: string; action?: string };
}
