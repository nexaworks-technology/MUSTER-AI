import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeAudit } from "@/lib/audit";
import { scopedDb } from "@/lib/db/scoped";
import { closeQueues } from "@/lib/jobs/queues";
import { recomputeAccounts } from "@/modules/health/service";
import { createTestAdmin } from "@/test/fixtures";
import { PROCESSORS } from "../processors";

/**
 * The job and worker paths read "today" from the business clock (Q-49, D-81). With the test-only
 * fake clock set, the nightly kickoff (also what a model activation queues) and the re-score write
 * the fake date; audit rows keep real time.
 */
const FAKE = "2026-11-02T17:00:00Z"; // midday Nov 2 in America/New_York
const saved = { allow: process.env.ALLOW_FAKE_CLOCK, now: process.env.APP_FAKE_NOW };

beforeAll(() => {
  process.env.ALLOW_FAKE_CLOCK = "true";
  process.env.APP_FAKE_NOW = FAKE;
});
afterAll(async () => {
  if (saved.allow === undefined) delete process.env.ALLOW_FAKE_CLOCK;
  else process.env.ALLOW_FAKE_CLOCK = saved.allow;
  if (saved.now === undefined) delete process.env.APP_FAKE_NOW;
  else process.env.APP_FAKE_NOW = saved.now;
  await closeQueues();
});

describe("business today in job and worker paths, under the fake clock", () => {
  it("the nightly kickoff (also queued by a model activation) dates its run the fake day", async () => {
    // A workspace with no accounts: the kickoff computes its date and enqueues no chunk jobs.
    const { actor } = await createTestAdmin("ClockKickoff");
    const kickoff = PROCESSORS.signals!["nightly.kickoff"]!;
    const out = (await kickoff({
      name: "nightly.kickoff",
      data: { workspaceId: actor.workspaceId, runId: `clock-${randomUUID()}` },
    } as Job)) as { asOf: string; chunks: number };
    expect(out).toMatchObject({ asOf: "2026-11-02", chunks: 0 });
  });

  it("a re-score (the activation and Pulse path) writes a snapshot dated the fake day", async () => {
    const { actor } = await createTestAdmin("ClockRescore");
    const db = scopedDb(actor);
    const account = await db.account.create({
      data: { workspaceId: actor.workspaceId, name: "Clocked", tier: "MID_TOUCH" },
    });
    await recomputeAccounts(actor, [account.id]);
    const snap = await db.healthScoreSnapshot.findFirstOrThrow({
      where: { accountId: account.id },
    });
    expect(snap.asOf.toISOString().slice(0, 10)).toBe("2026-11-02");
  });

  it("audit rows keep real time under the fake clock", async () => {
    const { actor } = await createTestAdmin("ClockAudit");
    const before = Date.now();
    const row = await writeAudit({
      workspaceId: actor.workspaceId,
      actorType: "SYSTEM",
      action: "test.clock",
      summary: "real time check",
    });
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(row.createdAt.toISOString().startsWith("2026-11-02T17:00")).toBe(false);
  });
});
