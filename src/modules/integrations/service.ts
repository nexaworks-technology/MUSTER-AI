import type { IntegrationProvider } from "@prisma/client";
import { z } from "zod";
import { env } from "@/lib/config/env";

/**
 * The integrations module's public surface (ARCHITECTURE §2, §8). Other modules and the worker
 * import from here only. Adapters, ingest and credentials stay internal.
 */
export {
  addNightlySyncFlow,
  enqueueSync,
  runSync,
  syncRunPayload,
  type SyncOutcome,
  type SyncRunPayload,
} from "./sync.jobs";
export {
  apiKeyInput,
  completeOAuth,
  ConnectError,
  connectWithApiKey,
  disconnect,
  startOAuth,
  testConnection,
} from "./connections.service";
export { OAUTH_NONCE_COOKIE, OAuthStateError } from "./oauth";
export {
  executeApprovedWriteBack,
  requestWriteBack,
  setWriteBack,
  WriteBackRefusedError,
} from "./writeback.service";
export { PROVIDER_NAMES } from "./providers";
export { listIntegrations, runSyncNow, type ProviderCard } from "./status.service";
export { DataHealthError, getDataHealth, retryDeadJob } from "./data-health.service";
export {
  handleSlackInteraction,
  linkSlackMembers,
  notifyApprovalRequested,
  notifySignalsOpened,
  sendDigestIfDue,
  SENSITIVE_DECISIONS_FROM_SLACK,
} from "./slack/service";
export {
  processWebhookEvent,
  receiveWebhook,
  type WebhookProcessResult,
  type WebhookResponse,
} from "./webhooks.service";

/** URL segment → provider (`/api/integrations/hubspot/...`). */
export const providerParam = z
  .enum(["hubspot", "salesforce", "stripe", "chargebee", "slack"])
  .transform((p) => p.toUpperCase() as IntegrationProvider);

/** True when connectors run on recorded fixtures (test, e2e, demo); never in production. */
export const fixtureMode = () => env().INTEGRATIONS_TRANSPORT === "fixture";
