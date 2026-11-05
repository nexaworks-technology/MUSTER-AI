import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { ingestBatch } from "../ingest.service";

describe("Meetings & Transcripts connectors integration", () => {
  it("ingests calendar meetings with contact & domain matching, keeping unmatched meetings accountId=null", async () => {
    const { actor: admin } = await createTestAdmin("meetings-ingest");
    const db = scopedDb(admin);

    // 1. Create known accounts and contacts
    const accAlpha = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Alpha Corp",
        domain: "alpha.test",
        tier: "HIGH_TOUCH",
      },
    });

    const contactAlpha = await db.contact.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: accAlpha.id,
        name: "Alice Alpha",
        email: "alice@alpha.test",
      },
    });

    const accBeta = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Beta Inc",
        domain: "beta.test",
        tier: "MID_TOUCH",
      },
    });

    const integration = await db.integration.create({
      data: {
        workspaceId: admin.workspaceId,
        provider: "GOOGLE_CALENDAR",
        status: "CONNECTED",
      },
    });

    const target = {
      workspaceId: admin.workspaceId,
      integrationId: integration.id,
      source: "GOOGLE_CALENDAR" as const,
    };

    // 2. Prepare meetings:
    // Meeting 1: attendee is alice@alpha.test -> matches accAlpha by contact
    // Meeting 2: attendee is bob@beta.test (no contact, but domain beta.test) -> matches accBeta by domain
    // Meeting 3: attendee is stranger@unknown.test -> unmatched, accountId = null
    const meetings = [
      {
        externalId: "m_alpha_1",
        title: "Alpha QBR",
        startsAt: new Date("2026-11-10T10:00:00Z"),
        endsAt: new Date("2026-11-10T11:00:00Z"),
        organizerEmail: "csm@larkspur.test",
        attendees: [
          { email: "csm@larkspur.test", name: "CSM", responseStatus: "ACCEPTED" as const },
          { email: "alice@alpha.test", name: "Alice Alpha", responseStatus: "ACCEPTED" as const },
        ],
        status: "SCHEDULED" as const,
      },
      {
        externalId: "m_beta_1",
        title: "Beta Sync",
        startsAt: new Date("2026-11-11T14:00:00Z"),
        endsAt: new Date("2026-11-11T14:30:00Z"),
        organizerEmail: "csm@larkspur.test",
        attendees: [
          { email: "bob@beta.test", name: "Bob Beta", responseStatus: "NEEDS_ACTION" as const },
        ],
        status: "SCHEDULED" as const,
      },
      {
        externalId: "m_unknown_1",
        title: "Mystery Meeting",
        startsAt: new Date("2026-11-12T15:00:00Z"),
        endsAt: new Date("2026-11-12T15:30:00Z"),
        organizerEmail: "stranger@unknown.test",
        attendees: [
          { email: "stranger@unknown.test", name: "Stranger", responseStatus: "ACCEPTED" as const },
        ],
        status: "SCHEDULED" as const,
      },
    ];

    const result = await ingestBatch(target, { kind: "meetings", records: meetings });
    expect(result.counts.created).toBe(3);

    // Verify stored meetings
    const storedMeetings = await db.meeting.findMany({
      where: { workspaceId: admin.workspaceId },
      include: { attendees: true },
      orderBy: { externalId: "asc" },
    });
    expect(storedMeetings).toHaveLength(3);

    // Meeting 1 -> matched to accAlpha
    const m1 = storedMeetings.find((m) => m.externalId === "m_alpha_1")!;
    expect(m1.accountId).toBe(accAlpha.id);
    expect(m1.title).toBe("Alpha QBR");
    const m1ContactAttendee = m1.attendees.find((a) => a.email === "alice@alpha.test")!;
    expect(m1ContactAttendee.contactId).toBe(contactAlpha.id);

    // Meeting 2 -> matched to accBeta by domain
    const m2 = storedMeetings.find((m) => m.externalId === "m_beta_1")!;
    expect(m2.accountId).toBe(accBeta.id);

    // Meeting 3 -> unmatched, accountId is null (NEVER guessed)
    const m3 = storedMeetings.find((m) => m.externalId === "m_unknown_1")!;
    expect(m3.accountId).toBeNull();

    // Idempotency check: run sync again
    const rerunResult = await ingestBatch(target, { kind: "meetings", records: meetings });
    expect(rerunResult.counts.created).toBe(0);
    expect(rerunResult.counts.updated).toBe(0);
    expect(rerunResult.counts.unchanged).toBe(3);
  });

  it("ingests call transcripts, links conversations and meetings, and is idempotent", async () => {
    const { actor: admin } = await createTestAdmin("transcripts-ingest");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Brightwell Logistics",
        domain: "brightwell.test",
        tier: "HIGH_TOUCH",
      },
    });

    const meeting = await db.meeting.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        externalId: "cal_meet_100",
        title: "Brightwell Onboarding Review",
        startsAt: new Date("2026-11-04T14:00:00Z"),
        endsAt: new Date("2026-11-04T15:00:00Z"),
        source: "GOOGLE_CALENDAR",
        status: "COMPLETED",
      },
    });

    // Also add ExternalRef for the meeting so meetingExternalId lookup works
    await db.externalRef.create({
      data: {
        workspaceId: admin.workspaceId,
        integrationId: (await db.integration.create({
          data: {
            workspaceId: admin.workspaceId,
            provider: "GOOGLE_CALENDAR",
            status: "CONNECTED",
          },
        })).id,
        objectType: "Meeting",
        externalId: "cal_meet_100",
        internalId: meeting.id,
        internalType: "Meeting",
        source: "GOOGLE_CALENDAR",
      },
    });

    const callIntegration = await db.integration.create({
      data: {
        workspaceId: admin.workspaceId,
        provider: "FIREFLIES",
        status: "CONNECTED",
      },
    });

    const target = {
      workspaceId: admin.workspaceId,
      integrationId: callIntegration.id,
      source: "FIREFLIES" as const,
    };

    const transcripts = [
      {
        externalId: "ff_trans_100",
        title: "Brightwell Onboarding Review Recording",
        occurredAt: new Date("2026-11-04T14:00:00Z"),
        text: "Leo: Welcome. Ben: Thanks, excited to get started.",
        language: "en",
        durationSec: 3600,
        meetingExternalId: "cal_meet_100",
        attendeeEmails: ["ben.okafor@brightwell.test"],
      },
    ];

    const result = await ingestBatch(target, { kind: "transcripts", records: transcripts });
    expect(result.counts.created).toBe(1);

    const storedTranscripts = await db.callTranscript.findMany({
      where: { workspaceId: admin.workspaceId },
    });
    expect(storedTranscripts).toHaveLength(1);
    expect(storedTranscripts[0]!.accountId).toBe(account.id);
    expect(storedTranscripts[0]!.title).toBe("Brightwell Onboarding Review Recording");
    expect(storedTranscripts[0]!.durationSec).toBe(3600);

    // Verify conversation was created and linked to the meeting
    const updatedMeeting = await db.meeting.findUnique({
      where: { id: meeting.id },
    });
    expect(updatedMeeting!.conversationId).not.toBeNull();
    expect(updatedMeeting!.conversationId).toBe(storedTranscripts[0]!.conversationId);

    // Replay idempotency
    const rerunResult = await ingestBatch(target, { kind: "transcripts", records: transcripts });
    expect(rerunResult.counts.created).toBe(0);
    expect(rerunResult.counts.unchanged).toBe(1);
  });
});
