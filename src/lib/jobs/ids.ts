import { randomUUID } from "node:crypto";
import { realClock, type Clock } from "@/lib/dates";

/**
 * Queue ids (Q-49 round 4, D-81). A timestamp in an id follows the same two-category rule as a
 * timestamp in logic:
 *
 *  - **Dedupe-intended** ids name a logical unit of work (workspace + business date + chunk, an
 *    outbox event, one agent trigger). A second enqueue of the same unit SHOULD be dropped, so
 *    these keep their business-date components and are built where they are used.
 *  - **Uniqueness-intended** ids name one specific enqueue event (a manual kickoff, a back-test
 *    request, a real-time hook firing). Every call MUST produce a job, so they are built here from
 *    real time plus a random component and never from the business clock: a pinned business clock
 *    would give two requests in one instant the same id, and the queue would drop the second.
 */
const suffix = (real: Clock) => `${real().getTime()}-${randomUUID().slice(0, 8)}`;

/** "Recompute now" and every model activation: one kickoff per request. */
export const manualRunId = (real: Clock = realClock) => `manual-${suffix(real)}`;

/** A real-time hook firing (Pulse, payment failure, ticket escalation). */
export const realtimeRunId = (reason: string, real: Clock = realClock) =>
  `rt-${reason.replace(/[^\w-]/g, "-").slice(0, 30)}-${suffix(real)}`;

/** One back-test request for a workspace. */
export const backtestJobId = (workspaceId: string, real: Clock = realClock) =>
  `${workspaceId}.backtest.${suffix(real)}`;

/**
 * The weekly leader digest for one workspace and one business week (M11 S7, D-91). Dedupe-intended:
 * `weekStart` is the Monday (a business date) of the week, so a second enqueue in the same week is
 * dropped by the queue; the digest service is idempotent per week as well.
 */
export const weeklyDigestJobId = (workspaceId: string, weekStart: string) =>
  `${workspaceId}.reports-weekly.${weekStart}`;
