import { describe, expect, it, vi } from "vitest";
import type { MemberAccess } from "@/lib/auth/permissions";
import { classifyJob, jobsOverview, retryJob, type JobLike, type QueueLike } from "../service";

/** M12 B4 — the Admin job dashboard shows one workspace's jobs and never anyone else's. */
const MINE = "ws_mine_000000000000000";
const THEIRS = "ws_theirs_00000000000000";
const admin: MemberAccess & { workspaceId: string; userId: string } = {
  role: "ADMIN",
  canViewRevenue: true,
  bookScope: "ALL",
  workspaceId: MINE,
  userId: "u1",
};

function job(over: Partial<JobLike> & { data?: unknown }): JobLike {
  return {
    id: "1",
    name: "x.run",
    data: {},
    attemptsMade: 3,
    timestamp: 1_000,
    finishedOn: 2_000,
    failedReason: "Boom for secret@example.com\n    at stack line",
    stacktrace: ["at secretFrame"],
    getState: async () => "failed",
    retry: vi.fn(async () => undefined),
    ...over,
  };
}

function queue(
  name: string,
  jobs: Record<string, JobLike[]>,
  schedulers: unknown[] = [],
): QueueLike {
  return {
    name,
    getJobs: async (types) => jobs[types[0]!] ?? [],
    getJobSchedulers: async () => schedulers as never,
    getJob: async (id) =>
      Object.values(jobs)
        .flat()
        .find((j) => j.id === id),
  };
}

describe("classifyJob", () => {
  it("is own, other or global by data.workspaceId", () => {
    expect(classifyJob({ workspaceId: MINE }, MINE)).toBe("own");
    expect(classifyJob({ workspaceId: THEIRS }, MINE)).toBe("other");
    expect(classifyJob({}, MINE)).toBe("global");
    expect(classifyJob(null, MINE)).toBe("global");
    expect(classifyJob("junk", MINE)).toBe("global");
  });
});

describe("jobsOverview", () => {
  const q = queue(
    "signals",
    {
      failed: [
        job({ id: "own1", data: { workspaceId: MINE, secret: "payload" } }),
        job({ id: "oth1", data: { workspaceId: THEIRS } }),
        job({ id: "glob1", name: "heartbeat", data: {} }),
      ],
      waiting: [
        job({ id: "w1", data: { workspaceId: THEIRS } }),
        job({ id: "w2", data: { workspaceId: MINE } }),
      ],
    },
    [
      { key: `nightly-${MINE}`, name: "nightly.kickoff", pattern: "0 2 * * *", next: 5 },
      { key: `nightly-${THEIRS}`, name: "nightly.kickoff", pattern: "0 2 * * *", next: 5 },
      { key: "outbox-dispatch", name: "outbox.dispatch", every: 60_000, next: 6 },
    ],
  );

  it("counts and lists only own and global jobs", async () => {
    const [o] = (await jobsOverview(admin, [q])).queues;
    expect(o!.counts.failed).toBe(2);
    expect(o!.counts.waiting).toBe(1);
    expect(o!.recentFailed.map((j) => j.id).sort()).toEqual(["glob1", "own1"]);
    expect(o!.schedules.map((s) => s.key).sort()).toEqual([`nightly-${MINE}`, "outbox-dispatch"]);
  });

  it("shows no data, stack or reason for global jobs, and a one-line reason for own", async () => {
    const [o] = (await jobsOverview(admin, [q])).queues;
    const glob = o!.recentFailed.find((j) => j.id === "glob1")!;
    expect(glob).not.toHaveProperty("failedReason");
    const own = o!.recentFailed.find((j) => j.id === "own1")!;
    expect(own.failedReason).toBe("Boom for [email]");
    const json = JSON.stringify(await jobsOverview(admin, [q]));
    for (const leaked of ["payload", "secretFrame", "stack line", "secret@example.com", THEIRS])
      expect(json, leaked).not.toContain(leaked);
  });

  it("is forbidden to non-Admins", async () => {
    await expect(jobsOverview({ ...admin, role: "CS_LEADER" }, [q])).rejects.toThrow(/Not allowed/);
  });
});

describe("retryJob", () => {
  it("retries only a failed job of the admin's own workspace", async () => {
    const own = job({ id: "own1", data: { workspaceId: MINE } });
    const oth = job({ id: "oth1", data: { workspaceId: THEIRS } });
    const glob = job({ id: "glob1", data: {} });
    const q = queue("signals", { failed: [own, oth, glob] });
    const audit = vi.fn(async () => undefined);
    await expect(
      retryJob(admin, { queue: "signals", jobId: "own1" }, { queues: [q], audit }),
    ).resolves.toBe(true);
    expect(own.retry).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
    for (const id of ["oth1", "glob1", "missing"])
      await expect(
        retryJob(admin, { queue: "signals", jobId: id }, { queues: [q], audit }),
      ).resolves.toBe(false);
    expect(oth.retry).not.toHaveBeenCalled();
    expect(glob.retry).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
  });
});
