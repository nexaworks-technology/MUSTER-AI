/**
 * Registry of workspace-scoped [W] Prisma models (ARCHITECTURE §3.1, §7.1).
 * Every model listed here: has `workspaceId`, `@@unique([workspaceId, id])`, RLS ENABLE + FORCE
 * with a `tenant_isolation` policy, and is auto-scoped by scopedDb(). The model-registry test
 * fails if a Prisma model is neither here nor in GLOBAL_MODELS.
 */
export const TENANT_MODELS = [
  "Membership",
  "Invitation",
  "WorkspaceSettings",
  "AuditLog",
  "Account",
  "Contact",
  "StakeholderRole",
  "Contract",
  "Subscription",
  "Invoice",
  "RevenueEvent",
  "UsageDaily",
  "UserUsageDaily",
  "FeatureUsageDaily",
  "FeatureCatalog",
  "Conversation",
  "Message",
  "Ticket",
  "CallTranscript",
  "Task",
  "NoteTemplate",
  "Note",
  "Notification",
  "Segment",
  "FileObject",
  "ExternalRef",
  "ImportJob",
  "MissingDataPrompt",
  "DataQualityIssue",
  "HealthModel",
  "HealthScoreSnapshot",
  "HealthReason",
  "CsmPulse",
  "UsageBaseline",
  "SignalRule",
  "Signal",
  "OutcomeRecord",
  "AgentDefinition",
  "AgentRun",
  "Approval",
  "DraftRevision",
  "OutboundMessage",
  "EmailSuppression",
  "TodayItem",
  "Extraction",
  "Integration",
  "SyncJob",
  "WebhookEvent",
  "SlackUserLink",
] as const;

/** Models without tenant scope: identity tables, the tenant root and the outbox (D-22). */
export const GLOBAL_MODELS = [
  "Workspace",
  "User",
  "AuthAccount",
  "Session",
  "VerificationToken",
  "OutboxEvent",
] as const;

export type TenantModel = (typeof TENANT_MODELS)[number];

const tenantSet: ReadonlySet<string> = new Set(TENANT_MODELS);

export function isTenantModel(model: string | undefined): model is TenantModel {
  return model !== undefined && tenantSet.has(model);
}
