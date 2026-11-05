/**
 * The M10 scenarios, run against the freshly seeded scratch database (see demo-m10.ts).
 * Tests the 4 core flows:
 *   1. Pre-call brief ready for Brightwell sync meeting at 14:00.
 *   2. QBR generated and locked with locked metrics and text-only narrative edits.
 *   3. Customer portal magic link view for Ben Okafor marking customer goal done with PORTAL_CONTACT audit.
 *   4. Survey intake and health feeding with source attribution and zero drift on other accounts.
 */
import { rawDb } from "../src/lib/db/raw";
import { scopedDb } from "../src/lib/db/scoped";
import type { AiProvider } from "../src/lib/ai";
import { generateQbr, lockQbrDocument, updateQbrNarrative } from "../src/modules/qbr/service";
import { createPortalAccess, getPortalView, updatePortalGoalProgress } from "../src/modules/portal/service";

const line = (s = "") => console.log(s);
const head = (s: string) => {
  line("\n" + "=".repeat(78));
  line(s);
  line("=".repeat(78));
};

const makeMockQbrProvider = (accountId: string): AiProvider => ({
  name: "recorded",
  async generateStructured<T>() {
    return {
      output: {
        reasoningSummary: "Generated executive review narrative.",
        confidence: 0.95,
        citations: [{ sourceType: "Account", sourceId: accountId }],
        proposedActions: [],
        title: "Q3 2026 Executive Business Review",
        summary: "Quarterly review of Brightwell Logistics operations.",
        decisions: ["Plan renewal review"],
        actionItems: [{ title: "Follow up with finance", ownerName: "Leo Marsh" }],
        suggestedQuestions: [],
        healthHighlights: ["Health At Risk following usage drop"],
        metrics: { overallHealth: 52.5, band: "AT_RISK" },
      } as T,
      stopReason: "end_turn",
      model: "recorded",
      requestId: null,
      inputTokens: 50,
      outputTokens: 100,
      latencyMs: 10,
    };
  },
});

async function main() {
  const ws = await rawDb.workspace.findFirstOrThrow({ where: { slug: "larkspur-demo" } });
  const db = scopedDb({ workspaceId: ws.id });
  const workspaceId = ws.id;

  const admin = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true) /* "workspaceId" = ${workspaceId} */`;
    return tx.membership.findFirstOrThrow({
      where: { workspaceId: ws.id, role: "ADMIN" },
      include: { user: true },
    });
  });

  const actor = {
    workspaceId: ws.id,
    userId: admin.userId,
    membershipId: admin.id,
    role: admin.role,
    canViewRevenue: true,
    bookScope: admin.bookScope,
    user: { id: admin.user.id, email: admin.user.email, name: admin.user.name },
  };

  const brightwell = await db.account.findFirstOrThrow({ where: { name: "Brightwell Logistics" } });
  const benContact = await db.contact.findFirstOrThrow({ where: { email: "ben.okafor@brightwell-logistics.test" } });

  let results = {
    flow1: "FAIL",
    flow2: "FAIL",
    flow3: "FAIL",
    flow4: "FAIL",
  };

  // --------------------------------------------------------------------------
  head("Flow 1: Pre-call brief ready for Brightwell sync meeting at 14:00");
  // --------------------------------------------------------------------------
  try {
    const meeting = await db.meeting.findFirstOrThrow({
      where: { accountId: brightwell.id, title: "Brightwell Logistics sync" },
      include: { attendees: true, briefDocument: true },
    });
    line(`meeting:     ${meeting.title} (${meeting.startsAt.toISOString().slice(11, 16)} UTC)`);
    line(`attendees:   ${meeting.attendees.map((a) => `${a.name} <${a.email}>`).join(", ")}`);
    line(`brief doc:   ${meeting.briefDocument?.title ?? "NONE"}`);

    if (meeting.briefDocument) {
      const metrics = meeting.briefDocument.metrics as Record<string, unknown>;
      line(`brief metrics: healthRisk=${metrics.healthRisk}, score=${metrics.healthScore}, renewal=${metrics.renewalDate}`);
      const narrative = meeting.briefDocument.narrative as Array<{ title: string; text: string }>;
      line(`brief sections: ${narrative.map((n) => n.title).join("; ")}`);
      if (metrics.healthRisk === "AT_RISK" && narrative.length >= 2) {
        results.flow1 = "PASS";
      }
    }
  } catch (err) {
    line(`Flow 1 error: ${String(err)}`);
  }
  line(`Flow 1 result: [${results.flow1}]`);

  // --------------------------------------------------------------------------
  head("Flow 2: QBR generated and locked with locked metrics and text-only narrative edits");
  // --------------------------------------------------------------------------
  try {
    const qbr = await generateQbr(
      actor,
      { accountId: brightwell.id, period: "Q3 2026" },
      { provider: makeMockQbrProvider(brightwell.id) },
    );
    line(`generated QBR: ${qbr.title} (origin: ${qbr.origin}, agentRunId: ${qbr.agentRunId})`);
    const metrics = (qbr.body.metrics as Record<string, unknown>) ?? {};
    line(`locked metrics revenue: ${(metrics.revenue as Record<string, unknown>)?.arrFormatted}`);
    line(`locked metrics health:  ${(metrics.health as Record<string, unknown>)?.band}`);

    // Test rejection of digits/currency in narrative edit
    let digitRejected = false;
    try {
      await updateQbrNarrative(actor, qbr.id, [
        {
          ...qbr.body.blocks[0]!,
          text: "We increased revenue to $50,000 this month.",
        },
      ]);
    } catch {
      digitRejected = true;
      line("validator correctly blocked currency/digit insertion in narrative.");
    }

    // Valid text-only update
    const updated = await updateQbrNarrative(actor, qbr.id, [
      {
        ...qbr.body.blocks[0]!,
        text: "Executive business review conducted with Brightwell Logistics leadership.",
      },
    ]);
    line(`updated narrative block text: "${updated.body.blocks[0]?.text}"`);

    // Lock document
    const locked = await lockQbrDocument(actor, qbr.id);
    line(`locked QBR: lockedAt=${locked.lockedAt?.toISOString()}`);

    const outbox = await db.outboxEvent.findFirst({
      where: { type: "business_review.followup" },
    });
    line(`outbox event: ${outbox?.type ?? "NONE"}`);

    if (digitRejected && locked.lockedAt !== null && outbox) {
      results.flow2 = "PASS";
    }
  } catch (err) {
    line(`Flow 2 error: ${String(err)}`);
  }
  line(`Flow 2 result: [${results.flow2}]`);

  // --------------------------------------------------------------------------
  head("Flow 3: Customer portal magic link view for Ben Okafor marking customer goal done");
  // --------------------------------------------------------------------------
  try {
    const { rawToken, access } = await createPortalAccess(actor, {
      accountId: brightwell.id,
      contactId: benContact.id,
    });
    line(`issued portal token: length=${rawToken.length}, expires=${access.expiresAt.toISOString()}`);

    const portalView = await getPortalView(rawToken);
    line(`portal view account: ${portalView.account.name}`);
    line(`portal view contact: ${portalView.contact.email}`);
    line(`portal shared plans: ${portalView.successPlans.length}`);
    line(`portal shared qbrs:  ${portalView.qbrDocuments.length}`);

    // Ben marks customer goal done
    const goal = await db.goal.findFirstOrThrow({
      where: { accountId: brightwell.id, text: "Invite finance team to executive review" },
    });
    const updatedGoal = await updatePortalGoalProgress(rawToken, {
      goalId: goal.id,
      status: "ACHIEVED",
    });
    line(`goal updated via portal: status=${updatedGoal.status}`);

    // Check audit log for PORTAL_CONTACT
    const audit = await db.auditLog.findFirst({
      where: {
        actorType: "PORTAL_CONTACT",
        actorId: benContact.id,
        action: "portal.goal_updated",
      },
      orderBy: { createdAt: "desc" },
    });
    line(`audit entry: actorType=${audit?.actorType}, actorId=${audit?.actorId}, action=${audit?.action}`);

    if (portalView.successPlans.length >= 1 && updatedGoal.status === "ACHIEVED" && audit) {
      results.flow3 = "PASS";
    }
  } catch (err) {
    line(`Flow 3 error: ${String(err)}`);
  }
  line(`Flow 3 result: [${results.flow3}]`);

  // --------------------------------------------------------------------------
  head("Flow 4: Survey intake and health feeding with source attribution");
  // --------------------------------------------------------------------------
  try {
    const response = await db.surveyResponse.findFirstOrThrow({
      where: { accountId: brightwell.id, contactId: benContact.id },
      include: { survey: true },
    });
    line(`survey response: type=${response.survey.type}, score=${response.score}/10, comment="${response.comment}"`);

    // Inspect Brightwell health score snapshot from seed
    const snapshot = await db.healthScoreSnapshot.findFirstOrThrow({
      where: { accountId: brightwell.id, asOf: new Date("2026-11-02") },
      orderBy: { createdAt: "desc" },
    });

    const sentimentScore = snapshot.sentiment ? Number(snapshot.sentiment) : null;
    line(`Brightwell Sentiment pillar: score=${sentimentScore ?? "null"}`);
    line(`Brightwell overall score: ${snapshot.overall} (band: ${snapshot.riskLevel})`);

    const sentimentReason = await db.healthReason.findFirst({
      where: { snapshotId: snapshot.id, component: "survey_average" },
    });
    const sources = (Array.isArray(sentimentReason?.sources) ? sentimentReason.sources : []) as Array<{ sourceType: string; sourceId: string }>;
    line(`Sentiment reason sources: ${sources.map((s) => `${s.sourceType}:${s.sourceId}`).join(", ")}`);
    const pointsToResponse = sources.some((s) => s.sourceType === "SurveyResponse" && s.sourceId === response.id);

    // Verify other accounts have null sentiment for seed asOf date
    const otherWithSentiment = await db.healthScoreSnapshot.count({
      where: {
        accountId: { not: brightwell.id },
        asOf: new Date("2026-11-02"),
        sentiment: { not: null },
      },
    });
    line(`Other accounts with sentiment data: ${otherWithSentiment}`);

    if (sentimentScore === 40 && pointsToResponse && otherWithSentiment === 0) {
      results.flow4 = "PASS";
    }
  } catch (err) {
    line(`Flow 4 error: ${String(err)}`);
  }
  line(`Flow 4 result: [${results.flow4}]`);

  // --------------------------------------------------------------------------
  head("Summary of Demo Results");
  // --------------------------------------------------------------------------
  line(`Flow 1 (Pre-call brief ready):              [${results.flow1}]`);
  line(`Flow 2 (QBR locked metrics & text narrative): [${results.flow2}]`);
  line(`Flow 3 (Portal magic link & contact audit):   [${results.flow3}]`);
  line(`Flow 4 (Survey intake & health feeding):      [${results.flow4}]`);

  const allPass = Object.values(results).every((r) => r === "PASS");
  if (!allPass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Demo failed with unhandled error:", err);
  process.exit(1);
});
