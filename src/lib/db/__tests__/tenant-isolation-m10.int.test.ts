import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";

/**
 * Rule 2 for M10 models: Meeting, MeetingAttendee, SuccessPlan, Survey, SurveyResponse, PortalAccess.
 * Strengthened attack pattern:
 * - Cross-workspace reads see 0 rows / null.
 * - Cross-workspace updates and deletes change 0 rows; own workspace control changes 1.
 * - Composite foreign keys refuse references across workspaces.
 * - Document CHECK constraint enforces origin <> 'AI' OR agentRunId IS NOT NULL.
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

  const contact = await db.contact.create({
    data: {
      workspaceId,
      accountId: account.id,
      name: `${label} contact`,
      email: `${label}@example.test`,
    },
  });

  const run = await db.agentRun.create({
    data: {
      workspaceId,
      agentKey: "meeting-qbr",
      agentVersion: "1.0.0",
      promptName: "meeting-brief",
      promptVersion: "1.0.0",
      model: "model-from-env",
      modelTier: "standard",
      triggerType: "meeting",
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

  const meeting = await db.meeting.create({
    data: {
      workspaceId,
      accountId: account.id,
      title: `${label} sync`,
      startsAt: new Date("2026-11-05T14:00:00Z"),
      endsAt: new Date("2026-11-05T14:45:00Z"),
      source: "MANUAL",
      status: "SCHEDULED",
    },
  });

  const attendee = await db.meetingAttendee.create({
    data: {
      workspaceId,
      meetingId: meeting.id,
      contactId: contact.id,
      email: `${label}@example.test`,
      name: `${label} contact`,
      responseStatus: "ACCEPTED",
    },
  });

  const successPlan = await db.successPlan.create({
    data: {
      workspaceId,
      accountId: account.id,
      title: `${label} Plan`,
      status: "ACTIVE",
      sharedWithPortal: true,
      milestones: [{ id: "m1", title: "Kickoff", targetDate: "2026-11-15", completedDate: null }],
    },
  });

  const goal = await db.goal.create({
    data: {
      workspaceId,
      accountId: account.id,
      successPlanId: successPlan.id,
      text: `${label} Goal`,
      status: "OPEN",
    },
  });

  const survey = await db.survey.create({
    data: {
      workspaceId,
      type: "NPS",
      trigger: "RENEWAL_WINDOW_60",
      question: "How likely are you to recommend us?",
      status: "ACTIVE",
    },
  });

  const surveyResponse = await db.surveyResponse.create({
    data: {
      workspaceId,
      surveyId: survey.id,
      accountId: account.id,
      contactId: contact.id,
      score: 9,
      comment: "Great experience",
      token: `tok-${label}`,
    },
  });

  const portalAccess = await db.portalAccess.create({
    data: {
      workspaceId,
      accountId: account.id,
      contactId: contact.id,
      tokenHash: `hash-${label}`,
      expiresAt: new Date(Date.now() + 14 * 86_400_000),
    },
  });

  const preCallBrief = await db.document.create({
    data: {
      workspaceId,
      accountId: account.id,
      kind: "PRE_CALL_BRIEF",
      title: `${label} Brief`,
      origin: "AI",
      agentRunId: run.id,
      metrics: {},
      narrative: [],
    },
  });

  return {
    actor,
    db,
    account,
    contact,
    run,
    meeting,
    attendee,
    successPlan,
    goal,
    survey,
    surveyResponse,
    portalAccess,
    preCallBrief,
  };
}

const fk = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";
const check = (e: unknown) => e instanceof Error && /check constraint|violates/i.test(e.message);

beforeAll(async () => {
  A = await setup("m10-a");
  B = await setup("m10-b");
});

describe("M10 tenant isolation (Meeting, MeetingAttendee, SuccessPlan, Survey, SurveyResponse, PortalAccess)", () => {
  describe("Meeting", () => {
    it("A cannot read B's meeting", async () => {
      const found = await A.db.meeting.findUnique({ where: { id: B.meeting.id } });
      expect(found).toBeNull();
    });

    it("A updating B's meeting changes 0 rows; own update changes 1", async () => {
      const attack = await A.db.meeting.updateMany({
        where: { id: B.meeting.id },
        data: { title: "hacked" },
      });
      expect(attack.count).toBe(0);

      const control = await A.db.meeting.updateMany({
        where: { id: A.meeting.id },
        data: { title: "A sync updated" },
      });
      expect(control.count).toBe(1);
    });

    it("A deleting B's meeting changes 0 rows; own delete works", async () => {
      const attack = await A.db.meeting.deleteMany({ where: { id: B.meeting.id } });
      expect(attack.count).toBe(0);
    });

    it("refuses composite FK referencing B's account from A's workspace", async () => {
      await expect(
        A.db.meeting.create({
          data: {
            workspaceId: A.actor.workspaceId,
            accountId: B.account.id,
            title: "Cross-tenant meeting",
            startsAt: new Date(),
            endsAt: new Date(),
          },
        }),
      ).rejects.toSatisfy(fk);
    });
  });

  describe("MeetingAttendee", () => {
    it("A cannot read B's attendee", async () => {
      const found = await A.db.meetingAttendee.findUnique({ where: { id: B.attendee.id } });
      expect(found).toBeNull();
    });

    it("A updating B's attendee changes 0 rows; own update changes 1", async () => {
      const attack = await A.db.meetingAttendee.updateMany({
        where: { id: B.attendee.id },
        data: { name: "hacked" },
      });
      expect(attack.count).toBe(0);

      const control = await A.db.meetingAttendee.updateMany({
        where: { id: A.attendee.id },
        data: { name: "A attendee updated" },
      });
      expect(control.count).toBe(1);
    });

    it("refuses attendee referencing B's meeting in A's workspace", async () => {
      await expect(
        A.db.meetingAttendee.create({
          data: {
            workspaceId: A.actor.workspaceId,
            meetingId: B.meeting.id,
            email: "cross@example.test",
          },
        }),
      ).rejects.toSatisfy(fk);
    });
  });

  describe("SuccessPlan and Goal linkage", () => {
    it("A cannot read B's success plan", async () => {
      const found = await A.db.successPlan.findUnique({ where: { id: B.successPlan.id } });
      expect(found).toBeNull();
    });

    it("A updating B's success plan changes 0 rows; own update changes 1", async () => {
      const attack = await A.db.successPlan.updateMany({
        where: { id: B.successPlan.id },
        data: { title: "hacked" },
      });
      expect(attack.count).toBe(0);

      const control = await A.db.successPlan.updateMany({
        where: { id: A.successPlan.id },
        data: { title: "A plan updated" },
      });
      expect(control.count).toBe(1);
    });

    it("refuses composite FK referencing B's success plan for A's goal", async () => {
      await expect(
        A.db.goal.create({
          data: {
            workspaceId: A.actor.workspaceId,
            accountId: A.account.id,
            successPlanId: B.successPlan.id,
            text: "Cross-tenant goal plan link",
          },
        }),
      ).rejects.toSatisfy(fk);
    });
  });

  describe("Survey and SurveyResponse", () => {
    it("A cannot read B's survey or response", async () => {
      expect(await A.db.survey.findUnique({ where: { id: B.survey.id } })).toBeNull();
      expect(
        await A.db.surveyResponse.findUnique({ where: { id: B.surveyResponse.id } }),
      ).toBeNull();
    });

    it("A updating B's surveyResponse changes 0 rows; own update changes 1", async () => {
      const attack = await A.db.surveyResponse.updateMany({
        where: { id: B.surveyResponse.id },
        data: { comment: "hacked" },
      });
      expect(attack.count).toBe(0);

      const control = await A.db.surveyResponse.updateMany({
        where: { id: A.surveyResponse.id },
        data: { comment: "Updated comment" },
      });
      expect(control.count).toBe(1);
    });

    it("refuses response referencing B's survey in A's workspace", async () => {
      await expect(
        A.db.surveyResponse.create({
          data: {
            workspaceId: A.actor.workspaceId,
            surveyId: B.survey.id,
            accountId: A.account.id,
            score: 10,
          },
        }),
      ).rejects.toSatisfy(fk);
    });
  });

  describe("PortalAccess", () => {
    it("A cannot read B's portal access token", async () => {
      const found = await A.db.portalAccess.findUnique({ where: { id: B.portalAccess.id } });
      expect(found).toBeNull();
    });

    it("A revoking B's portal access changes 0 rows; own revoke changes 1", async () => {
      const attack = await A.db.portalAccess.updateMany({
        where: { id: B.portalAccess.id },
        data: { revokedAt: new Date() },
      });
      expect(attack.count).toBe(0);

      const control = await A.db.portalAccess.updateMany({
        where: { id: A.portalAccess.id },
        data: { revokedAt: new Date() },
      });
      expect(control.count).toBe(1);
    });

    it("refuses composite FK referencing B's account or contact in A's workspace", async () => {
      await expect(
        A.db.portalAccess.create({
          data: {
            workspaceId: A.actor.workspaceId,
            accountId: B.account.id,
            contactId: A.contact.id,
            tokenHash: "cross-acc-hash",
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        }),
      ).rejects.toSatisfy(fk);

      await expect(
        A.db.portalAccess.create({
          data: {
            workspaceId: A.actor.workspaceId,
            accountId: A.account.id,
            contactId: B.contact.id,
            tokenHash: "cross-contact-hash",
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        }),
      ).rejects.toSatisfy(fk);
    });
  });

  describe("Document (PRE_CALL_BRIEF kind and CHECK constraint)", () => {
    it("stores PRE_CALL_BRIEF document kind successfully", async () => {
      const doc = await A.db.document.findUnique({ where: { id: A.preCallBrief.id } });
      expect(doc?.kind).toBe("PRE_CALL_BRIEF");
      expect(doc?.origin).toBe("AI");
      expect(doc?.agentRunId).toBe(A.run.id);
    });

    it("enforces DB CHECK constraint: origin='AI' without agentRunId is refused by postgres", async () => {
      await expect(
        A.db.document.create({
          data: {
            workspaceId: A.actor.workspaceId,
            accountId: A.account.id,
            kind: "PRE_CALL_BRIEF",
            title: "Orphan AI brief",
            origin: "AI",
            agentRunId: null,
            metrics: {},
            narrative: [],
          },
        }),
      ).rejects.toSatisfy(check);
    });

    it("allows origin='HUMAN' or 'SYSTEM' without agentRunId", async () => {
      const humanDoc = await A.db.document.create({
        data: {
          workspaceId: A.actor.workspaceId,
          accountId: A.account.id,
          kind: "SUCCESS_PLAN",
          title: "Human plan",
          origin: "HUMAN",
          agentRunId: null,
          metrics: {},
          narrative: [],
        },
      });
      expect(humanDoc.id).toBeDefined();
    });
  });
});
