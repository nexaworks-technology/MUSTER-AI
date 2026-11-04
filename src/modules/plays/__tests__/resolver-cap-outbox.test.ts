import { describe, expect, it } from "vitest";
import { dispatchOutbox, writeOutboxEvent, type Enqueue, type OutboxRoutes } from "@/lib/jobs/outbox";
import { scopedDb } from "@/lib/db/scoped";
import { approve, reject } from "@/modules/approvals/service";
import { createNote } from "@/modules/notes/service";
import { createTestAdmin } from "@/test/fixtures";
import { checkRuntimeFrequencyCap } from "../runtime-cap";
import { resolvePlayStepLevel } from "../step-resolver";

describe("S4: Step-level resolver and pure run-time cap check (RED FIRST)", () => {
  describe("step-level resolver (reusing M4's logic)", () => {
    it("resolves SEND_AUTOMATICALLY for long-tail safe step when auto-send is enabled", () => {
      const level = resolvePlayStepLevel({
        step: {
          key: "s1",
          name: "Reminder",
          handler: "send",
          params: {},
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "SEND_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        tier: "LONG_TAIL",
        workspaceCeiling: "SEND_AUTOMATICALLY",
        autoSendEnabled: true,
        isSensitive: false,
      });
      expect(level).toBe("SEND_AUTOMATICALLY");
    });

    it("caps SEND_AUTOMATICALLY at DRAFT_FOR_APPROVAL for mid-touch or high-touch", () => {
      const level = resolvePlayStepLevel({
        step: {
          key: "s1",
          name: "Reminder",
          handler: "send",
          params: {},
          approvalLevelByTier: {
            HIGH_TOUCH: "SEND_AUTOMATICALLY",
            MID_TOUCH: "SEND_AUTOMATICALLY",
            LONG_TAIL: "SEND_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        tier: "MID_TOUCH",
        workspaceCeiling: "SEND_AUTOMATICALLY",
        autoSendEnabled: true,
        isSensitive: false,
      });
      expect(level).toBe("DRAFT_FOR_APPROVAL");
    });

    it("caps at DRAFT_FOR_APPROVAL if step is not marked safe", () => {
      const level = resolvePlayStepLevel({
        step: {
          key: "s1",
          name: "Reminder",
          handler: "send",
          params: {},
          approvalLevelByTier: {
            HIGH_TOUCH: "SEND_AUTOMATICALLY",
            MID_TOUCH: "SEND_AUTOMATICALLY",
            LONG_TAIL: "SEND_AUTOMATICALLY",
          },
          safe: false, // NOT safe
          sensitive: false,
        },
        tier: "LONG_TAIL",
        workspaceCeiling: "SEND_AUTOMATICALLY",
        autoSendEnabled: true,
        isSensitive: false,
      });
      expect(level).toBe("DRAFT_FOR_APPROVAL");
    });

    it("sensitive cap wins over autoSendEnabled and tier (Rule 3)", () => {
      const level = resolvePlayStepLevel({
        step: {
          key: "s1",
          name: "Cancellation offer",
          handler: "send",
          params: {},
          approvalLevelByTier: {
            HIGH_TOUCH: "SEND_AUTOMATICALLY",
            MID_TOUCH: "SEND_AUTOMATICALLY",
            LONG_TAIL: "SEND_AUTOMATICALLY",
          },
          safe: true,
          sensitive: true, // Sensitive!
        },
        tier: "LONG_TAIL",
        workspaceCeiling: "SEND_AUTOMATICALLY",
        autoSendEnabled: true,
        isSensitive: true,
      });
      expect(level).toBe("DRAFT_FOR_APPROVAL");
    });

    it("workspace ceiling caps the level", () => {
      const level = resolvePlayStepLevel({
        step: {
          key: "s1",
          name: "Reminder",
          handler: "send",
          params: {},
          approvalLevelByTier: {
            HIGH_TOUCH: "SEND_AUTOMATICALLY",
            MID_TOUCH: "SEND_AUTOMATICALLY",
            LONG_TAIL: "SEND_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        tier: "LONG_TAIL",
        workspaceCeiling: "DRAFT_FOR_APPROVAL", // Ceiling
        autoSendEnabled: true,
        isSensitive: false,
      });
      expect(level).toBe("DRAFT_FOR_APPROVAL");
    });
  });

  describe("pure run-time frequency cap check (D1)", () => {
    const now = new Date("2026-11-04T12:00:00Z");

    it("passes when neither contact nor account was recently emailed", () => {
      const res = checkRuntimeFrequencyCap({
        now,
        contactCooldownHours: 72,
        lastSentToContactAt: new Date("2026-10-31T00:00:00Z"), // 4+ days ago
        otherPlayCooldownHours: 48,
        lastOtherSendToAccountAt: new Date("2026-11-01T00:00:00Z"), // 3+ days ago
      });
      expect(res.breached).toBe(false);
      expect(res.guard).toBeUndefined();
    });

    it("detects contact_recently_emailed breach when contact was emailed 12 hours ago", () => {
      const res = checkRuntimeFrequencyCap({
        now,
        contactCooldownHours: 72,
        lastSentToContactAt: new Date("2026-11-04T00:00:00Z"), // 12 hours ago
        otherPlayCooldownHours: 48,
        lastOtherSendToAccountAt: null,
      });
      expect(res.breached).toBe(true);
      expect(res.guard).toBe("contact_recently_emailed");
      expect(res.reason).toContain("This contact was emailed 12 hours ago (limit 72)");
    });

    it("detects account_recently_emailed breach when another play emailed account 24 hours ago", () => {
      const res = checkRuntimeFrequencyCap({
        now,
        contactCooldownHours: 72,
        lastSentToContactAt: null,
        otherPlayCooldownHours: 48,
        lastOtherSendToAccountAt: new Date("2026-11-03T12:00:00Z"), // 24 hours ago
      });
      expect(res.breached).toBe(true);
      expect(res.guard).toBe("account_recently_emailed");
      expect(res.reason).toContain("Another send reached this account 24 hours ago (limit 48)");
    });
  });

  describe("outbox fan-out (D3)", () => {
    it("single target route keeps jobId byte-identical: outbox-${event.id}", async () => {
      const { actor } = await createTestAdmin("OutboxSingle");
      const db = scopedDb(actor);

      const event = await db.$tenantTransaction((tx) =>
        writeOutboxEvent(tx, {
          workspaceId: actor.workspaceId,
          type: "single.event",
          payload: { foo: "bar" },
        }),
      );

      const enqueued: Array<{ queue: string; job: string; jobId: string }> = [];
      const mockEnqueue: Enqueue = async (queue, job, _data, jobId) => {
        enqueued.push({ queue, job, jobId });
      };

      const routes: OutboxRoutes = {
        "single.event": { queue: "signals", job: "test.single" },
      };

      const res = await dispatchOutbox(routes, {
        enqueue: mockEnqueue,
        workspaceId: actor.workspaceId,
      });

      expect(res.dispatched).toBe(1);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toEqual({
        queue: "signals",
        job: "test.single",
        jobId: `outbox-${event.id}`, // Byte-identical!
      });
    });

    it("fanned-out route enqueues to all targets with distinct jobIds", async () => {
      const { actor } = await createTestAdmin("OutboxFan");
      const db = scopedDb(actor);

      const event = await db.$tenantTransaction((tx) =>
        writeOutboxEvent(tx, {
          workspaceId: actor.workspaceId,
          type: "fanout.event",
          payload: { count: 42 },
        }),
      );

      const enqueued: Array<{ queue: string; job: string; jobId: string }> = [];
      const mockEnqueue: Enqueue = async (queue, job, _data, jobId) => {
        enqueued.push({ queue, job, jobId });
      };

      const routes: OutboxRoutes = {
        "fanout.event": [
          { queue: "agents", job: "agent.listener" },
          { queue: "plays", job: "play.listener" },
        ],
      };

      const res = await dispatchOutbox(routes, {
        enqueue: mockEnqueue,
        workspaceId: actor.workspaceId,
      });

      expect(res.dispatched).toBe(1);
      expect(enqueued).toHaveLength(2);
      expect(enqueued[0]).toEqual({
        queue: "agents",
        job: "agent.listener",
        jobId: `outbox-${event.id}-0`,
      });
      expect(enqueued[1]).toEqual({
        queue: "plays",
        job: "play.listener",
        jobId: `outbox-${event.id}-1`,
      });
    });
  });

  describe("approval.decided and note.created events (D3)", () => {
    it("approval decision emits approval.decided outbox event", async () => {
      const { actor } = await createTestAdmin("ApprDecide");
      const db = scopedDb(actor);

      const account = await db.account.create({
        data: { workspaceId: actor.workspaceId, name: "Decision Corp", tier: "MID_TOUCH" },
      });

      const approval = await db.approval.create({
        data: {
          workspaceId: actor.workspaceId,
          accountId: account.id,
          kind: "SEND_EMAIL",
          sourceKey: "test:decide:1",
          reason: "Test email draft",
          requiredLevel: "DRAFT_FOR_APPROVAL",
          status: "PENDING",
        },
      });

      await approve(actor, { approvalId: approval.id });

      const outbox = await db.outboxEvent.findFirstOrThrow({
        where: {
          workspaceId: actor.workspaceId,
          type: "approval.decided",
        },
      });
      expect(outbox.payload).toMatchObject({
        approvalId: approval.id,
        status: "APPROVED",
        accountId: account.id,
      });

      // Reject case
      const approval2 = await db.approval.create({
        data: {
          workspaceId: actor.workspaceId,
          accountId: account.id,
          kind: "SEND_EMAIL",
          sourceKey: "test:decide:2",
          reason: "Test email draft 2",
          requiredLevel: "DRAFT_FOR_APPROVAL",
          status: "PENDING",
        },
      });

      await reject(actor, { approvalId: approval2.id, note: "Not appropriate now" });

      const outboxReject = await db.outboxEvent.findFirstOrThrow({
        where: {
          workspaceId: actor.workspaceId,
          type: "approval.decided",
          payload: { path: ["status"], equals: "REJECTED" },
        },
      });
      expect(outboxReject.payload).toMatchObject({
        approvalId: approval2.id,
        status: "REJECTED",
      });
    });

    it("creating a note emits note.created outbox event with tags", async () => {
      const { actor } = await createTestAdmin("NoteOutbox");
      const db = scopedDb(actor);

      const account = await db.account.create({
        data: { workspaceId: actor.workspaceId, name: "Note Corp", tier: "MID_TOUCH" },
      });

      const { note } = await createNote(actor, {
        accountId: account.id,
        body: "Customer mentioned they are considering cancelling",
        tags: ["cancellation-risk", "churn"],
      });

      const outbox = await db.outboxEvent.findFirstOrThrow({
        where: {
          workspaceId: actor.workspaceId,
          type: "note.created",
        },
      });
      expect(outbox.payload).toMatchObject({
        noteId: note.id,
        accountId: account.id,
        tags: ["cancellation-risk", "churn"],
      });
    });
  });
});
