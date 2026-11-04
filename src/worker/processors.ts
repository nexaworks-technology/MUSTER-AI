import type { Job } from "bullmq";
import { env } from "@/lib/config/env";
import { dispatchOutbox, OUTBOX_ROUTES } from "@/lib/jobs/outbox";
import type { QueueName } from "@/lib/jobs/queues";
import { logger } from "@/lib/logger";
import { businessClock } from "@/lib/dates";
import { listActiveWorkspaces } from "@/lib/db/workspace";
import { getQueue } from "@/lib/jobs/queues";
import {
  processAgentRun,
  processConsider,
  sweepAllExpansionAgents,
  sweepAllHealthNarratives,
  processReextract,
  sweepAllExtractions,
  sweepAllRenewalAgents,
} from "@/modules/agents/service";
import { importJobPayload, runImportJob } from "@/modules/imports/service";
import {
  notifyApprovalRequested,
  processUsageAggregate,
  processWebhookEvent,
  runSync,
  sendDigestIfDue,
} from "@/modules/integrations/service";
import {
  onOnboardingStalled,
  onOnboardingValueReached,
  sweepAllOnboardingAgents,
} from "@/modules/onboarding/service";
import {
  evaluateRevenueCheckpoints,
  evaluateSevenDayCheckpoints,
} from "@/modules/outcomes/service";
import { escalateOverdueTasks } from "@/modules/tasks/service";
import { rebuildWorkspaceToday } from "@/modules/today/service";
import { createPipelineProcessors } from "@/modules/signals/service";
import {
  processPlayApprovalDecided,
  processPlayEnter,
  processPlayNoteCreated,
  processPlaySignalOpened,
  processPlayStallSweep,
  processPlayStep,
} from "@/modules/plays/service";

const pipeline = createPipelineProcessors({ clock: businessClock });

/**
 * One repeatable nightly kickoff per active workspace, at 02:00 in that workspace's time zone
 * (ARCHITECTURE §1.2). Idempotent: re-registering updates the schedule in place.
 */
export async function syncNightlySchedules(opts: { enabled?: boolean } = {}): Promise<number> {
  // NIGHTLY_SCHEDULES=off (e2e worker only): register nothing. Unset keeps production behaviour.
  if (!(opts.enabled ?? env().NIGHTLY_SCHEDULES !== "off")) return 0;
  const workspaces = await listActiveWorkspaces();
  for (const w of workspaces)
    await getQueue("signals").upsertJobScheduler(
      `nightly-${w.id}`,
      { pattern: "0 2 * * *", tz: w.timezone },
      { name: "nightly.kickoff", data: { workspaceId: w.id }, opts: { attempts: 3 } },
    );
  return workspaces.length;
}

/**
 * Job handlers by queue and job name. Tenant handlers (added from M2/M3 on) must parse their
 * payload with Zod and use scopedDb({ workspaceId: payload.workspaceId }).
 */
export type Processor = (job: Job) => Promise<unknown>;

export const PROCESSORS: Partial<Record<QueueName, Record<string, Processor>>> = {
  sync: {
    /** CSV import run (M2, D-47); re-scoped by the payload's workspaceId. */
    async "import.run"(job) {
      const { workspaceId, importJobId } = importJobPayload.parse(job.data);
      await runImportJob(workspaceId, importJobId);
      return { importJobId };
    },
    /** M5: one integration sync (nightly flow child, "Run sync now", setup import). */
    async "sync.run"(job) {
      return runSync(job.data);
    },
    /** M6: one Usage API batch folded into the daily usage tables (D-23; events live only here). */
    async "usage.aggregate"(job) {
      return processUsageAggregate(job);
    },
    /** M5: one verified webhook event: ingest, then real-time evaluation of its account. */
    async "webhook.process"(job) {
      return processWebhookEvent(job.data);
    },
  },
  /** M5: internal Slack deliveries (never customer contact; D4). */
  outbound: {
    async "slack.approvalRequested"(job) {
      return notifyApprovalRequested(job.data);
    },
  },
  /** M3: the nightly run and the real-time hook (signals → health), scoped by payload. */
  signals: pipeline.signals,
  health: pipeline.health,
  /** M4: the 7-day outcome checkpoint (ARCHITECTURE §6.5); idempotent per record. */
  outcomes: {
    async "outcomes.checkpoint"() {
      const out: Record<string, number> = {};
      for (const w of await listActiveWorkspaces()) {
        out[w.slug] = (await evaluateSevenDayCheckpoints({ workspaceId: w.id })).evaluated;
        // M7: renewed / expanded / contracted / churned, from renewal outcomes and revenue events.
        await evaluateRevenueCheckpoints({ workspaceId: w.id });
      }
      return out;
    },
  },
  /** M4: one agent run per job, scoped by the payload's workspaceId (ARCHITECTURE §1.3). */
  agents: {
    async "agents.run"(job) {
      return processAgentRun(job.data);
    },
    async "health-analyst.consider"(job) {
      return processConsider(job.data);
    },
    async "health-analyst.sweep"() {
      return sweepAllHealthNarratives();
    },
    /** M9: the Watcher reads new messages, notes and call chunks (a few per pass). */
    async "conversations.extractSweep"() {
      return sweepAllExtractions();
    },
    /** M9: after an explicit Watcher prompt-version bump, read again what the old version read. */
    async "conversations.reextract"(job) {
      return processReextract(job.data);
    },
    /** M6: a stalled plan tells its owner and asks the Onboarding Manager for a draft. */
    async "onboarding.stalled"(job) {
      return onOnboardingStalled(job.data);
    },
    /** M7: an open renewal-window signal on a renewal with no brief asks the Renewal Manager once. */
    async "renewals.agentsSweep"() {
      return sweepAllRenewalAgents();
    },
    /** M7: an open expansion opportunity with no run asks the Expansion Finder once. */
    async "expansion.agentsSweep"() {
      return sweepAllExpansionAgents();
    },
    /** M6: first value reached tells the owner. */
    async "onboarding.valueReached"(job) {
      return onOnboardingValueReached(job.data);
    },
    /** M6: customer steps due today and open adoption signals ask the two M6 agents once each. */
    async "onboarding.agentsSweep"() {
      return sweepAllOnboardingAgents();
    },
  },
  maintenance: {
    async "nightly.schedules"() {
      return { workspaces: await syncNightlySchedules() };
    },
    async heartbeat(job) {
      const at = new Date().toISOString();
      logger.info({ jobId: job.id, at }, "worker heartbeat");
      return { at };
    },
    async "outbox.dispatch"() {
      return dispatchOutbox(OUTBOX_ROUTES);
    },
    /** M4: overdue tasks escalate to the CS Leaders (§6F3); idempotent per task. */
    async "tasks.escalateOverdue"() {
      const out: Record<string, number> = {};
      for (const w of await listActiveWorkspaces())
        out[w.slug] = (await escalateOverdueTasks({ workspaceId: w.id })).escalated;
      return out;
    },
    /** M4: every member's Today, re-ranked (pages also rebuild a stale Today on read). */
    async "today.rebuildAll"() {
      const out: Record<string, number> = {};
      for (const w of await listActiveWorkspaces()) {
        out[w.slug] = await rebuildWorkspaceToday({ workspaceId: w.id });
        // M5 (D-95): the Slack morning digest follows the Today rebuild, once per business date.
        await sendDigestIfDue({ workspaceId: w.id, timezone: w.timezone }).catch((err: unknown) =>
          logger.warn(
            { workspaceId: w.id, err: err instanceof Error ? err.name : "unknown" },
            "slack digest failed",
          ),
        );
      }
      return out;
    },
  },
  plays: {
    async "plays.enter"(job) {
      return processPlayEnter(job.data);
    },
    async "plays.step"(job) {
      return processPlayStep(job.data);
    },
    async "plays.approvalDecided"(job) {
      return processPlayApprovalDecided(job.data);
    },
    async "plays.noteCreated"(job) {
      return processPlayNoteCreated(job.data);
    },
    async "plays.signalOpened"(job) {
      return processPlaySignalOpened(job.data);
    },
    async "plays.stallSweep"(job) {
      return processPlayStallSweep(job.data);
    },
  },
};

/** Repeating maintenance jobs, registered idempotently at worker start. */
export const SCHEDULES = [
  { queue: "maintenance", id: "heartbeat", job: "heartbeat", everyMs: 60_000 },
  { queue: "maintenance", id: "outbox-dispatch", job: "outbox.dispatch", everyMs: 5_000 },
  // New workspaces get their nightly run within the hour (and at worker start, see index.ts).
  { queue: "maintenance", id: "nightly-schedules", job: "nightly.schedules", everyMs: 3_600_000 },
  // M4: narratives for snapshots no event covers (first snapshot, top-reason change).
  { queue: "agents", id: "health-analyst-sweep", job: "health-analyst.sweep", everyMs: 900_000 },
  // M9: the Watcher for new messages, notes and call chunks.
  {
    queue: "agents",
    id: "conversations-extract-sweep",
    job: "conversations.extractSweep",
    everyMs: 900_000,
  },
  // M6: the Onboarding Manager for steps due today, the Adoption Coach for adoption signals.
  {
    queue: "agents",
    id: "onboarding-agents-sweep",
    job: "onboarding.agentsSweep",
    everyMs: 900_000,
  },
  // M7: the Renewal Manager for renewals inside their window that have no brief yet.
  { queue: "agents", id: "renewal-agents-sweep", job: "renewals.agentsSweep", everyMs: 900_000 },
  { queue: "agents", id: "expansion-agents-sweep", job: "expansion.agentsSweep", everyMs: 900_000 },
  { queue: "maintenance", id: "task-escalation", job: "tasks.escalateOverdue", everyMs: 3_600_000 },
  { queue: "outcomes", id: "outcomes-checkpoint", job: "outcomes.checkpoint", everyMs: 21_600_000 },
  { queue: "maintenance", id: "today-rebuild", job: "today.rebuildAll", everyMs: 3_600_000 },
  { queue: "plays", id: "plays-stall-sweep", job: "plays.stallSweep", everyMs: 3_600_000 },
] as const;

export function processorFor(queue: QueueName): Processor | undefined {
  const handlers = PROCESSORS[queue];
  if (!handlers) return undefined;
  return async (job) => {
    const handler = handlers[job.name];
    // An unknown job fails visibly (dead-letter after retries) instead of being dropped.
    if (!handler) throw new Error(`No handler for ${queue}/${job.name}`);
    return handler(job);
  };
}
