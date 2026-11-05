import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";

/**
 * Rule 2 for M11 models: ReportSnapshot, AskThread, AskMessage (plus the DB-level guards that
 * ship with them: report immutability, the assistant-message CHECK, frozen outcome checkpoints).
 * Pattern: cross-workspace read null; cross-workspace update/delete change 0 while the own-row
 * control changes 1; composite FKs refuse cross-workspace parents; raw SQL without the workspace
 * setting sees 0 rows.
 */
type Side = Awaited<ReturnType<typeof setup>>;
let A: Side;
let B: Side;

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const workspaceId = actor.workspaceId;
  const db = scopedDb(actor);

  const account = await db.account.create({
    data: { workspaceId, name: `${label} account`, tier: "MID_TOUCH" },
  });

  const run = await db.agentRun.create({
    data: {
      workspaceId,
      agentKey: "report-digest",
      agentVersion: "1.0.0",
      promptName: "report-digest",
      promptVersion: "1.0.0",
      model: "model-from-env",
      modelTier: "standard",
      triggerType: "report",
      triggerId: label,
      idempotencyKey: `idem-${label}`,
      inputRefs: [{ sourceType: "Account", sourceId: account.id }],
      accountId: account.id,
      status: "SUCCEEDED",
      output: { items: [] },
      reasoningSummary: "r",
      confidence: 0.9,
    },
  });

  const report = await db.reportSnapshot.create({
    data: {
      workspaceId,
      reportKey: "portfolio-health",
      periodStart: new Date("2026-10-01"),
      periodEnd: new Date("2026-10-31"),
      filters: {},
      filtersHash: "h0",
      data: { total: 3 },
      trigger: "MANUAL",
      generatedByMembershipId: actor.membershipId,
      generatedAt: new Date("2026-11-01T00:00:00Z"),
    },
  });

  const thread = await db.askThread.create({
    data: {
      workspaceId,
      userId: actor.userId,
      membershipId: actor.membershipId,
      title: `${label} thread`,
    },
  });

  const message = await db.askMessage.create({
    data: { workspaceId, threadId: thread.id, role: "USER", content: "How are my accounts?" },
  });

  const outcome = await db.outcomeRecord.create({
    data: {
      workspaceId,
      accountId: account.id,
      flagType: "RISK",
      flaggedAt: new Date("2026-09-01T00:00:00Z"),
    },
  });

  return { actor, db, account, run, report, thread, message, outcome };
}

const fk = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";

beforeAll(async () => {
  A = await setup("m11-a");
  B = await setup("m11-b");
});

describe("M11 tenant isolation (ReportSnapshot, AskThread, AskMessage)", () => {
  describe("ReportSnapshot", () => {
    it("A cannot read B's report", async () => {
      expect(await A.db.reportSnapshot.findUnique({ where: { id: B.report.id } })).toBeNull();
    });

    it("cross-tenant update changes 0 rows; own update of data is refused by the immutability trigger", async () => {
      const attack = await A.db.reportSnapshot.updateMany({
        where: { id: B.report.id },
        data: { data: { total: 999 } },
      });
      expect(attack.count).toBe(0);
      await expect(
        A.db.reportSnapshot.updateMany({
          where: { id: A.report.id },
          data: { data: { total: 999 } },
        }),
      ).rejects.toThrow(/immutable/i);
    });

    it("digestAgentRunId can be set once from NULL, then never changed", async () => {
      const set = await A.db.reportSnapshot.updateMany({
        where: { id: A.report.id },
        data: { digestAgentRunId: A.run.id },
      });
      expect(set.count).toBe(1);
      await expect(
        A.db.reportSnapshot.updateMany({
          where: { id: A.report.id },
          data: { digestAgentRunId: null },
        }),
      ).rejects.toThrow(/only once/i);
    });

    it("cross-tenant delete changes 0 rows; own delete changes 1", async () => {
      const own = await A.db.reportSnapshot.create({
        data: {
          workspaceId: A.actor.workspaceId,
          reportKey: "to-delete",
          periodStart: new Date("2026-10-01"),
          periodEnd: new Date("2026-10-31"),
          filtersHash: "h1",
          data: {},
          trigger: "SCHEDULED",
          generatedAt: new Date(),
        },
      });
      expect((await A.db.reportSnapshot.deleteMany({ where: { id: B.report.id } })).count).toBe(0);
      expect((await A.db.reportSnapshot.deleteMany({ where: { id: own.id } })).count).toBe(1);
      expect(await B.db.reportSnapshot.findUnique({ where: { id: B.report.id } })).not.toBeNull();
    });

    it("refuses a digest run from another workspace", async () => {
      await expect(
        A.db.reportSnapshot.create({
          data: {
            workspaceId: A.actor.workspaceId,
            reportKey: "x",
            periodStart: new Date("2026-10-01"),
            periodEnd: new Date("2026-10-31"),
            filtersHash: "h2",
            data: {},
            trigger: "MANUAL",
            generatedAt: new Date(),
            digestAgentRunId: B.run.id,
          },
        }),
      ).rejects.toSatisfy(fk);
    });
  });

  describe("AskThread", () => {
    it("A cannot read B's thread", async () => {
      expect(await A.db.askThread.findUnique({ where: { id: B.thread.id } })).toBeNull();
    });

    it("cross-tenant update changes 0 rows; own update changes 1", async () => {
      const attack = await A.db.askThread.updateMany({
        where: { id: B.thread.id },
        data: { title: "hacked" },
      });
      expect(attack.count).toBe(0);
      const control = await A.db.askThread.updateMany({
        where: { id: A.thread.id },
        data: { title: "renamed" },
      });
      expect(control.count).toBe(1);
    });

    it("cross-tenant delete changes 0 rows; own delete changes 1", async () => {
      const own = await A.db.askThread.create({
        data: {
          workspaceId: A.actor.workspaceId,
          userId: A.actor.userId,
          membershipId: A.actor.membershipId,
          title: "to delete",
        },
      });
      expect((await A.db.askThread.deleteMany({ where: { id: B.thread.id } })).count).toBe(0);
      expect((await A.db.askThread.deleteMany({ where: { id: own.id } })).count).toBe(1);
    });

    it("refuses a membership from another workspace", async () => {
      await expect(
        A.db.askThread.create({
          data: {
            workspaceId: A.actor.workspaceId,
            userId: A.actor.userId,
            membershipId: B.actor.membershipId,
            title: "cross",
          },
        }),
      ).rejects.toSatisfy(fk);
    });
  });

  describe("AskMessage", () => {
    it("A cannot read B's message", async () => {
      expect(await A.db.askMessage.findUnique({ where: { id: B.message.id } })).toBeNull();
    });

    it("cross-tenant update changes 0 rows; own update changes 1", async () => {
      const attack = await A.db.askMessage.updateMany({
        where: { id: B.message.id },
        data: { content: "hacked" },
      });
      expect(attack.count).toBe(0);
      const control = await A.db.askMessage.updateMany({
        where: { id: A.message.id },
        data: { content: "edited" },
      });
      expect(control.count).toBe(1);
    });

    it("cross-tenant delete changes 0 rows; own delete changes 1", async () => {
      const own = await A.db.askMessage.create({
        data: {
          workspaceId: A.actor.workspaceId,
          threadId: A.thread.id,
          role: "USER",
          content: "x",
        },
      });
      expect((await A.db.askMessage.deleteMany({ where: { id: B.message.id } })).count).toBe(0);
      expect((await A.db.askMessage.deleteMany({ where: { id: own.id } })).count).toBe(1);
    });

    it("refuses a message in B's thread, and an assistant message citing B's run", async () => {
      await expect(
        A.db.askMessage.create({
          data: {
            workspaceId: A.actor.workspaceId,
            threadId: B.thread.id,
            role: "USER",
            content: "cross",
          },
        }),
      ).rejects.toSatisfy(fk);
      await expect(
        A.db.askMessage.create({
          data: {
            workspaceId: A.actor.workspaceId,
            threadId: A.thread.id,
            role: "ASSISTANT",
            content: "cross",
            agentRunId: B.run.id,
          },
        }),
      ).rejects.toSatisfy(fk);
    });

    it("ask_message_agent_run_required: an ASSISTANT message without an AgentRun is refused", async () => {
      await expect(
        A.db.askMessage.create({
          data: {
            workspaceId: A.actor.workspaceId,
            threadId: A.thread.id,
            role: "ASSISTANT",
            content: "orphan AI text",
          },
        }),
      ).rejects.toThrow(/ask_message_agent_run_required|check constraint/i);
      const ok = await A.db.askMessage.create({
        data: {
          workspaceId: A.actor.workspaceId,
          threadId: A.thread.id,
          role: "ASSISTANT",
          content: "answer",
          agentRunId: A.run.id,
        },
      });
      expect(ok.agentRunId).toBe(A.run.id);
    });
  });

  it.each(["ReportSnapshot", "AskThread", "AskMessage"])(
    "%s: raw SQL as the runtime role without the workspace setting sees 0 rows",
    async (model) => {
      const rows = await rawDb.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${model}"`,
      );
      expect(Number(rows[0]?.n)).toBe(0);
    },
  );

  describe("OutcomeRecord checkpoints are frozen (outcome_checkpoint_frozen)", () => {
    const frozen = /frozen/i;

    it("d30Outcome: NULL -> value allowed; value -> other and value -> NULL refused", async () => {
      const id = A.outcome.id;
      const set = await A.db.outcomeRecord.updateMany({
        where: { id },
        data: { d30Outcome: { status: "NO_CHANGE" } },
      });
      expect(set.count).toBe(1);
      await expect(
        A.db.outcomeRecord.updateMany({
          where: { id },
          data: { d30Outcome: { status: "RECOVERED" } },
        }),
      ).rejects.toThrow(frozen);
      await expect(
        A.db.outcomeRecord.updateMany({ where: { id }, data: { d30Outcome: Prisma.DbNull } }),
      ).rejects.toThrow(frozen);
    });

    it("d90Outcome: NULL -> value allowed; value -> other refused", async () => {
      const id = A.outcome.id;
      expect(
        (
          await A.db.outcomeRecord.updateMany({
            where: { id },
            data: { d90Outcome: { status: "X" } },
          })
        ).count,
      ).toBe(1);
      await expect(
        A.db.outcomeRecord.updateMany({ where: { id }, data: { d90Outcome: { status: "Y" } } }),
      ).rejects.toThrow(frozen);
    });

    it("isTrueAlarm: NULL -> value allowed; value -> other and value -> NULL refused", async () => {
      const id = A.outcome.id;
      expect(
        (await A.db.outcomeRecord.updateMany({ where: { id }, data: { isTrueAlarm: true } })).count,
      ).toBe(1);
      await expect(
        A.db.outcomeRecord.updateMany({ where: { id }, data: { isTrueAlarm: false } }),
      ).rejects.toThrow(frozen);
      await expect(
        A.db.outcomeRecord.updateMany({ where: { id }, data: { isTrueAlarm: null } }),
      ).rejects.toThrow(frozen);
    });

    it("other OutcomeRecord columns stay editable after the checkpoints are frozen", async () => {
      const r = await A.db.outcomeRecord.updateMany({
        where: { id: A.outcome.id },
        data: { csmAgreed: true },
      });
      expect(r.count).toBe(1);
    });
  });
});
