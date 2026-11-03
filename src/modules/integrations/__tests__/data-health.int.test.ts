import { Worker } from "bullmq";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { scopedDb } from "@/lib/db/scoped";
import { closeQueues, getQueue, queuePrefix, redisConnection } from "@/lib/jobs/queues";
import { createTestAdmin } from "@/test/fixtures";
import { DataHealthError, getDataHealth, retryDeadJob } from "../data-health.service";

/**
 * Settings › Data health (ARCH §1.2): a job that failed after all its tries is listed in plain
 * words for its own workspace only; another workspace cannot see or re-run it; failed syncs and
 * webhook events are listed with their plain reason, never a raw error.
 */
vi.hoisted(() => {
  process.env.QUEUE_PREFIX = "nexaworks-datahealth-test";
});
const workers: Worker<unknown, unknown>[] = [];
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});

async function failOnce(workspaceId: string) {
  const job = await getQueue("sync").add(
    "sync.run",
    { workspaceId, integrationId: "x", kind: "FULL", trigger: "MANUAL", runKey: "r" },
    { attempts: 1 },
  );
  for (let i = 0; i < 100; i++) {
    if ((await job.getState()) === "failed") return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("job did not fail");
}

describe("Data health", () => {
  it("lists a dead job, a failed sync and a failed webhook in plain words, for its own workspace only", async () => {
    workers.push(
      new Worker(
        "sync",
        async (): Promise<unknown> => {
          throw new Error("internal stack detail that must not be shown");
        },
        { connection: redisConnection(), prefix: queuePrefix() },
      ),
    );
    const A = await createTestAdmin("DhA");
    const B = await createTestAdmin("DhB");
    const job = await failOnce(A.actor.workspaceId);
    const db = scopedDb(A.actor);
    const integration = await db.integration.create({
      data: { workspaceId: A.actor.workspaceId, provider: "STRIPE" },
    });
    await db.syncJob.create({
      data: {
        workspaceId: A.actor.workspaceId,
        integrationId: integration.id,
        kind: "FULL",
        trigger: "NIGHTLY",
        runKey: "n",
        status: "FAILED",
        errorPlain: "Stripe had a problem on its side (HTTP 500).",
      },
    });
    await db.webhookEvent.create({
      data: {
        workspaceId: A.actor.workspaceId,
        integrationId: integration.id,
        externalEventId: "evt_f",
        eventType: "invoice.paid",
        payloadStorageKey: "k",
        status: "FAILED",
        errorPlain: "This event could not be processed; it will be retried.",
      },
    });

    const a = await getDataHealth(A.actor);
    expect(a.jobs).toEqual([
      expect.objectContaining({
        queue: "sync",
        jobId: String(job.id),
        label: "An integration sync",
        attempts: 1,
      }),
    ]);
    expect(JSON.stringify(a)).not.toContain("internal stack detail");
    expect(a.syncs).toEqual([
      expect.objectContaining({
        provider: "Stripe",
        errorPlain: "Stripe had a problem on its side (HTTP 500).",
      }),
    ]);
    expect(a.webhooks).toEqual([
      expect.objectContaining({ provider: "Stripe", eventType: "invoice.paid" }),
    ]);

    const b = await getDataHealth(B.actor);
    expect(b).toEqual({ jobs: [], syncs: [], webhooks: [] });
    await expect(
      retryDeadJob(B.actor, { queue: "sync", jobId: String(job.id) }),
    ).rejects.toBeInstanceOf(DataHealthError);
    await expect(getDataHealth({ ...A.actor, role: "CSM" })).rejects.toBeInstanceOf(ForbiddenError);

    await retryDeadJob(A.actor, { queue: "sync", jobId: String(job.id) });
    expect(await db.auditLog.count({ where: { action: "data_health.retried" } })).toBe(1);
  });
});
