import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { bulkDecide } from "@/modules/approvals/service";
import { createTestAdmin } from "@/test/fixtures";
import { createSurvey, dispatchSurvey, getSurveyMetrics, submitSurveyResponse } from "../service";

describe("Surveys Engine & Approvals Integration", () => {
  it("creates a survey and calculates metrics cleanly", async () => {
    const admin = await createTestAdmin("SurveyTest1");
    const ws = admin.workspace.id;
    const actor = { ...admin.actor, workspaceId: ws };

    const survey = await createSurvey(actor, {
      type: "NPS",
      trigger: "ONBOARDING_VALUE_REACHED",
      question: "How likely are you to recommend us to a colleague?",
    });
    expect(survey.id).toBeDefined();

    // Check empty metrics
    const initialMetrics = await getSurveyMetrics(actor, survey.id);
    expect(initialMetrics).toEqual({
      type: "NPS",
      n: 0,
      score: null,
      promoters: 0,
      passives: 0,
      detractors: 0,
      averageScore: null,
    });
  });

  it("dispatches survey through Approvals and allows tokenized submission", async () => {
    const admin = await createTestAdmin("SurveyTest2");
    const ws = admin.workspace.id;
    const actor = { ...admin.actor, workspaceId: ws };
    const db = scopedDb(actor);

    const account = await db.account.create({
      data: {
        workspaceId: ws,
        name: "Acme Survey Corp",
        tier: "HIGH_TOUCH",
      },
    });

    const contact = await db.contact.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        name: "Jane Doe",
        email: "jane@acme-survey.test",
        status: "ACTIVE",
      },
    });

    const survey = await createSurvey(actor, {
      type: "NPS",
      trigger: "TICKET_CLOSED",
      question: "How was your support experience?",
    });

    const { approval, token } = await dispatchSurvey(actor, {
      surveyId: survey.id,
      accountId: account.id,
      contactId: contact.id,
    });

    expect(approval.kind).toBe("SEND_EMAIL");
    expect(approval.status).toBe("PENDING");
    expect(approval.sourceKey).toContain(`survey:${survey.id}:${contact.id}`);

    // Submit response via token
    const response = await submitSurveyResponse({
      token,
      score: 9,
      comment: "Great experience!",
    });

    expect(response.id).toBeDefined();
    expect(response.score).toBe(9);
    expect(response.contactId).toBe(contact.id);

    // Duplicate submission should fail
    await expect(
      submitSurveyResponse({
        token,
        score: 8,
      }),
    ).rejects.toThrow("This survey has already been submitted.");

    // Metrics should now show 1 promoter
    const metrics = await getSurveyMetrics(actor, survey.id);
    expect(metrics).toEqual({
      type: "NPS",
      n: 1,
      score: 100,
      promoters: 1,
      passives: 0,
      detractors: 0,
      averageScore: 9,
    });
  });

  it("batch-approved survey to a contact emailed 2 days ago is rescheduled, not sent (Q-30, acceptance #8)", async () => {
    const admin = await createTestAdmin("SurveyTest3");
    const ws = admin.workspace.id;
    const actor = { ...admin.actor, workspaceId: ws };
    const db = scopedDb(actor);

    const account = await db.account.create({
      data: {
        workspaceId: ws,
        name: "Batch Survey Account",
        tier: "MID_TOUCH",
      },
    });

    const contact = await db.contact.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        name: "Cooling Contact",
        email: "cooling@batch.test",
        timezone: "America/New_York",
        status: "ACTIVE",
      },
    });

    // Record an email sent 2 days ago (48 hours ago; cooldown is 72h)
    const twoDaysAgo = new Date(Date.now() - 48 * 3600_000);
    await db.outboundMessage.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        contactId: contact.id,
        toEmail: contact.email!,
        subject: "Earlier contact",
        bodyText: "Checking in",
        status: "SENT",
        sendMode: "APPROVED",
        sentAt: twoDaysAgo,
        providerMessageId: "msg-prev-1",
      },
    });

    const survey = await createSurvey(actor, {
      type: "NPS",
      trigger: "RENEWAL_WINDOW_60",
      question: "How has your renewal experience been?",
    });

    const { approval } = await dispatchSurvey(actor, {
      surveyId: survey.id,
      accountId: account.id,
      contactId: contact.id,
    });

    // Now approve it via bulkDecide (daily batch approval)
    const results = await bulkDecide(actor, {
      approvalIds: [approval.id],
      confirmedIds: [approval.id],
      decision: "approve",
    });

    expect(results[0]!.approval.status).toBe("APPROVED");
    expect(results[0]!.send?.status).toBe("RESCHEDULED");

    // The message should be RESCHEDULED, not sent
    const msg = await db.outboundMessage.findFirstOrThrow({
      where: { approvalId: approval.id },
    });
    expect(msg.status).toBe("HELD");
    expect(msg.heldReason).toContain("RESCHEDULED");
    expect(msg.heldReason).toContain("contact was emailed");
  });
});
