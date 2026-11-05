import type { ScopedDb } from "@/lib/db/scoped";
import { atHour, daysAgo } from "./dates";
import { ids, seedId } from "./ids";

/**
 * Seed data for Milestone M10:
 * - Brightwell Logistics sync meeting today at 14:00 with pre-call brief ready
 * - Seeded NPS survey and Ben Okafor's detractor response (score 4/10) feeding Brightwell's health
 * - Brightwell success plan shared with customer portal
 */
export async function seedM10(db: ScopedDb, workspaceId: string): Promise<void> {
  const brightwellId = ids.account("brightwell");
  const benContactId = ids.contact("brightwell", "ben");
  const leoMembershipId = ids.membership("leo");

  // 1. Seed NPS Survey & Ben Okafor's response (feeding health)
  await db.play.updateMany({
    where: { key: "promise-late" },
    data: { status: "DRAFT" },
  });

  const surveyId = seedId("survey:nps-default");
  await db.survey.upsert({
    where: { id: surveyId },
    create: {
      id: surveyId,
      workspaceId,
      type: "NPS",
      trigger: "RENEWAL_WINDOW_60",
      question: "How likely are you to recommend NexaWorks to a colleague?",
      status: "ACTIVE",
    },
    update: {
      type: "NPS",
      question: "How likely are you to recommend NexaWorks to a colleague?",
      status: "ACTIVE",
    },
  });

  const responseId = seedId("survey-response:brightwell-ben");
  const respondedAt = daysAgo(5);
  await db.surveyResponse.upsert({
    where: { id: responseId },
    create: {
      id: responseId,
      workspaceId,
      surveyId,
      accountId: brightwellId,
      contactId: benContactId,
      score: 4,
      comment: "Product functionality is solid, but we need clearer ROI before the upcoming renewal.",
      token: "token-brightwell-ben-nps",
      respondedAt,
    },
    update: {
      score: 4,
      comment: "Product functionality is solid, but we need clearer ROI before the upcoming renewal.",
      respondedAt,
    },
  });

  // 2. Brightwell Meeting today at 14:00 with pre-call brief
  const meetingId = seedId("meeting:brightwell-sync-today");
  // Today at 14:00 UTC
  const today1400 = atHour(daysAgo(0), 14, 0);
  const today1430 = atHour(daysAgo(0), 14, 30);

  const meeting = await db.meeting.upsert({
    where: { id: meetingId },
    create: {
      id: meetingId,
      workspaceId,
      accountId: brightwellId,
      title: "Brightwell Logistics sync",
      startsAt: today1400,
      endsAt: today1430,
      status: "SCHEDULED",
    },
    update: {
      title: "Brightwell Logistics sync",
      startsAt: today1400,
      endsAt: today1430,
      status: "SCHEDULED",
    },
  });

  // Attendees
  const leoAttendeeId = seedId("attendee:brightwell-sync-today:leo");
  await db.meetingAttendee.upsert({
    where: { id: leoAttendeeId },
    create: {
      id: leoAttendeeId,
      workspaceId,
      meetingId: meeting.id,
      name: "Leo Marsh",
      email: "leo@larkspur.test",
      responseStatus: "ACCEPTED",
    },
    update: {
      name: "Leo Marsh",
      email: "leo@larkspur.test",
      responseStatus: "ACCEPTED",
    },
  });

  const benAttendeeId = seedId("attendee:brightwell-sync-today:ben");
  await db.meetingAttendee.upsert({
    where: { id: benAttendeeId },
    create: {
      id: benAttendeeId,
      workspaceId,
      meetingId: meeting.id,
      contactId: benContactId,
      name: "Ben Okafor",
      email: "ben.okafor@brightwell-logistics.test",
      responseStatus: "ACCEPTED",
    },
    update: {
      contactId: benContactId,
      name: "Ben Okafor",
      email: "ben.okafor@brightwell-logistics.test",
      responseStatus: "ACCEPTED",
    },
  });

  // Pre-call Brief Document
  const briefDocId = seedId("doc:brief:brightwell-sync-today");
  await db.document.upsert({
    where: { id: briefDocId },
    create: {
      id: briefDocId,
      workspaceId,
      accountId: brightwellId,
      kind: "PRE_CALL_BRIEF",
      title: "Pre-call Brief: Brightwell Logistics sync",
      origin: "SYSTEM",
      metrics: {
        meetingId: meeting.id,
        healthRisk: "AT_RISK",
        healthScore: 52.5,
        renewalDate: "2026-12-15",
      },
      narrative: [
        {
          id: "b1",
          type: "summary",
          title: "Account Overview & Risk Reasons",
          text: "Health is At Risk following a drop in active users and champion Maya Ortiz departing. An outside signal indicates an acquisition by Haverford Group.",
        },
        {
          id: "b2",
          type: "questions",
          title: "Suggested Questions for Ben Okafor",
          text: "1. How is the finance team approaching software budget allocation post-acquisition?\n2. What reporting capabilities are required for ROI sign-off?",
        },
      ],
    },
    update: {
      title: "Pre-call Brief: Brightwell Logistics sync",
      metrics: {
        meetingId: meeting.id,
        healthRisk: "AT_RISK",
        healthScore: 52.5,
        renewalDate: "2026-12-15",
      },
      narrative: [
        {
          id: "b1",
          type: "summary",
          title: "Account Overview & Risk Reasons",
          text: "Health is At Risk following a drop in active users and champion Maya Ortiz departing. An outside signal indicates an acquisition by Haverford Group.",
        },
        {
          id: "b2",
          type: "questions",
          title: "Suggested Questions for Ben Okafor",
          text: "1. How is the finance team approaching software budget allocation post-acquisition?\n2. What reporting capabilities are required for ROI sign-off?",
        },
      ],
    },
  });

  // Link brief document to meeting
  await db.meeting.update({
    where: { id: meeting.id },
    data: { briefDocumentId: briefDocId },
  });

  // 3. Brightwell Success Plan with Goals shared with Portal
  const planId = seedId("plan:brightwell-q4");
  const plan = await db.successPlan.upsert({
    where: { id: planId },
    create: {
      id: planId,
      workspaceId,
      accountId: brightwellId,
      title: "Q4 Value Delivery & Executive Alignment",
      sharedWithPortal: true,
    },
    update: {
      title: "Q4 Value Delivery & Executive Alignment",
      sharedWithPortal: true,
    },
  });

  const goals = [
    { key: "g1", text: "Invite finance team to executive review", status: "OPEN" as const },
    { key: "g2", text: "Implement custom reporting pipeline", status: "OPEN" as const },
    { key: "g3", text: "Complete security and compliance audit", status: "ACHIEVED" as const },
  ];

  for (const g of goals) {
    const goalId = seedId(`goal:brightwell:${g.key}`);
    await db.goal.upsert({
      where: { id: goalId },
      create: {
        id: goalId,
        workspaceId,
        accountId: brightwellId,
        successPlanId: plan.id,
        text: g.text,
        status: g.status,
      },
      update: {
        text: g.text,
        status: g.status,
      },
    });
  }
}
