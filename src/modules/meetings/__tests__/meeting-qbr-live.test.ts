import { describe, expect, it } from "vitest";
import { AiProviderError, type AiProvider } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { generateQbr } from "@/modules/qbr/service";
import { prepareBrief } from "../service";

/**
 * DEMO-WALKTHROUGH FAIL 34/35: the Meeting & QBR agent's output schema was rejected by the live
 * provider, and an in-app retry of the same QBR reused the failed run. These pin the fixed shape,
 * the number check every AI narrative gets (D-75), and that a retry is a fresh run.
 */
type Answer = Record<string, unknown>;
const provider = (answer: (bundleIds: string[]) => Answer): AiProvider => ({
  name: "recorded",
  async generateStructured<T>(req: { input: string }) {
    const ids = [...req.input.matchAll(/"sourceId":\s*"([^"]+)"/g)].map((m) => m[1]!);
    return {
      output: answer(ids) as T,
      stopReason: "end_turn",
      model: "recorded",
      requestId: null,
      inputTokens: 10,
      outputTokens: 20,
      latencyMs: 5,
    };
  },
});

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const account = await db.account.create({
    data: { workspaceId: actor.workspaceId, name: `${label} Co`, tier: "HIGH_TOUCH" },
  });
  return { actor, db, account };
}

describe("pre-call brief (meeting-qbr PREPARE_BRIEF)", () => {
  it("builds the brief from typed fields and titles it from the meeting, not the model", async () => {
    const { actor, db, account } = await setup("brief-typed");
    const meeting = await db.meeting.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: account.id,
        title: "Quarterly sync",
        startsAt: new Date("2026-11-27T15:00:00Z"),
        endsAt: new Date("2026-11-27T16:00:00Z"),
      },
    });
    const doc = await prepareBrief(
      actor,
      { meetingId: meeting.id },
      {
        provider: provider(() => ({
          reasoningSummary: "From the meeting record.",
          confidence: 0.8,
          citations: [{ sourceType: "Meeting", sourceId: meeting.id }],
          summary: "The sync is on Nov 27.",
          healthHighlights: ["Engagement is steady."],
          recentActivity: ["A positive email last week."],
          openItems: ["No open promises."],
          suggestedQuestions: ["What should the next quarter focus on?"],
        })),
      },
    );
    expect(doc.title).toBe("Pre-call Brief: Quarterly sync");
    const blocks = doc.narrative as Array<{ type: string; text?: string; items?: string[] }>;
    expect(blocks.map((b) => b.type)).toEqual([
      "summary",
      "health",
      "activity",
      "open_items",
      "questions",
    ]);
    expect(blocks[2]!.items).toEqual(["A positive email last week."]);
  });

  it("refuses a brief that states a number no cited record holds", async () => {
    const { actor, db, account } = await setup("brief-number");
    const meeting = await db.meeting.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: account.id,
        title: "Sync",
        startsAt: new Date("2026-11-27T15:00:00Z"),
        endsAt: new Date("2026-11-27T16:00:00Z"),
      },
    });
    await expect(
      prepareBrief(
        actor,
        { meetingId: meeting.id },
        {
          provider: provider(() => ({
            reasoningSummary: "Guessing.",
            confidence: 0.5,
            citations: [{ sourceType: "Account", sourceId: account.id }],
            summary: "Health is 88 and climbing.",
          })),
        },
      ),
    ).rejects.toThrow(/run/);
    const run = await db.agentRun.findFirstOrThrow({
      where: { agentKey: "meeting-qbr", accountId: account.id },
    });
    expect(run.status).toBe("UNCITED");
    expect(await db.document.count({ where: { accountId: account.id } })).toBe(0);
  });
});

describe("QBR (meeting-qbr QBR_NARRATIVE)", () => {
  it("gives the agent the account's health, contract and plan records to cite", async () => {
    const { actor, db, account } = await setup("qbr-context");
    const plan = await db.successPlan.create({
      data: { workspaceId: actor.workspaceId, accountId: account.id, title: "FY27 plan" },
    });
    const goal = await db.goal.create({
      data: {
        workspaceId: actor.workspaceId,
        accountId: account.id,
        successPlanId: plan.id,
        text: "Close the books in five days",
        status: "ACHIEVED",
      },
    });
    let seen: string[] = [];
    const doc = await generateQbr(
      actor,
      { accountId: account.id, period: "Q4 2026", nonce: "n-1" },
      {
        provider: provider((ids) => {
          seen = ids;
          return {
            reasoningSummary: "From the goal.",
            confidence: 0.8,
            citations: [{ sourceType: "Goal", sourceId: goal.id }],
            summary: "The team achieved its goal to close the books faster.",
          };
        }),
      },
    );
    expect(seen).toContain(goal.id);
    expect(doc.title).toBe(`Q4 2026 Business Review: ${account.name}`);
  });

  it("a narrative may name the period when it cites the period record, and not otherwise", async () => {
    const w = await setup("qbr-period");
    const answer = (cite: boolean) =>
      provider(() => ({
        reasoningSummary: "Period review.",
        confidence: 0.7,
        citations: cite
          ? [{ sourceType: "QbrPeriod", sourceId: "Q4 2026" }]
          : [{ sourceType: "Account", sourceId: w.account.id }],
        summary: "A steady Q4 2026 for the team.",
      }));
    await expect(
      generateQbr(
        w.actor,
        { accountId: w.account.id, period: "Q4 2026", nonce: "a" },
        { provider: answer(false) },
      ),
    ).rejects.toThrow();
    const doc = await generateQbr(
      w.actor,
      { accountId: w.account.id, period: "Q4 2026", nonce: "b" },
      { provider: answer(true) },
    );
    expect(doc.kind).toBe("QBR");
  });

  it("a retry after a failed generation starts a fresh run and succeeds", async () => {
    const { actor, db, account } = await setup("qbr-retry");
    const failing: AiProvider = {
      name: "recorded",
      async generateStructured() {
        throw new AiProviderError("http_400", "the provider refused the request");
      },
    };
    await expect(
      generateQbr(
        actor,
        { accountId: account.id, period: "Q4 2026", nonce: "first" },
        {
          provider: failing,
        },
      ),
    ).rejects.toThrow();
    const doc = await generateQbr(
      actor,
      { accountId: account.id, period: "Q4 2026", nonce: "second" },
      {
        provider: provider(() => ({
          reasoningSummary: "From the account.",
          confidence: 0.7,
          citations: [{ sourceType: "Account", sourceId: account.id }],
          summary: "A steady quarter.",
        })),
      },
    );
    expect(doc.kind).toBe("QBR");
    const runs = await db.agentRun.findMany({
      where: { agentKey: "meeting-qbr", accountId: account.id },
      orderBy: { createdAt: "asc" },
      select: { status: true },
    });
    expect(runs.map((r) => r.status)).toEqual(["FAILED", "SUCCEEDED"]);
  });
});
