import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { askQuestion, getThread, type AskActor } from "../service";

/**
 * M11 S10: the Ask AI loop on the database with an in-test provider (no API key on this machine;
 * the same pattern as the other agents' int tests). Proves: code runs the tools the planner asks
 * for, as the asker; one AgentRun per answer with prompt name/version, model and the record ids it
 * read (Rule 5); a validated answer is stored with its citations; an answer with a number that is
 * in no cited record is stored as UNCITED and never as text; "I cannot see a contract" for an
 * account with none; a proposal becomes a PENDING Approval and changes nothing; a member without
 * revenue access never receives a revenue figure; a conversation belongs to its user only.
 */
type Answer = (
  records: Array<{ sourceType: string; sourceId: string; fields: Record<string, unknown> }>,
) => unknown;
type Calls = Array<{ tool: string; input: Record<string, unknown> }>;

function provider(calls: Calls, answer: Answer): AiProvider {
  return {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      let output: unknown;
      if (req.promptRef.startsWith("ask-ai-plan@")) {
        const step = (JSON.parse(req.input) as { step: number }).step;
        output = step === 1 && calls.length ? { action: "call", calls } : { action: "answer" };
      } else {
        const start = req.input.indexOf("[");
        output = answer(JSON.parse(req.input.slice(start)));
      }
      return {
        output: req.schema.parse(output) as T,
        stopReason: "end_turn",
        model: "test-model",
        requestId: randomUUID(),
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 1,
      };
    },
  };
}
const base = { reasoningSummary: "Used the records.", confidence: 0.7, proposedActions: [] };

let admin: AskActor;
let db: ScopedDb;
let ws: string;
let northgate: { id: string };
let fairhaven: { id: string };
let playId: string;

async function member(
  role: "CSM" | "CS_LEADER",
  canViewRevenue: boolean,
  workspaceId = ws,
): Promise<AskActor> {
  const user = await rawDb.user.create({
    data: { email: `m-${randomUUID().slice(0, 8)}@example.test`, name: role },
  });
  const m = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx.membership.create({
      data: {
        workspaceId,
        userId: user.id,
        role,
        bookScope: role === "CSM" ? "OWN" : "ALL",
        canViewRevenue,
      },
    });
  });
  return {
    workspaceId,
    userId: user.id,
    membershipId: m.id,
    role: m.role,
    canViewRevenue,
    bookScope: m.bookScope,
  };
}

beforeAll(async () => {
  ({ actor: admin } = await createTestAdmin("AskLoop"));
  ws = admin.workspaceId;
  db = scopedDb(admin);
  northgate = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Northgate Freight",
      tier: "HIGH_TOUCH",
      ownerMembershipId: admin.membershipId,
    },
  });
  fairhaven = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Fairhaven Dental",
      tier: "MID_TOUCH",
      ownerMembershipId: admin.membershipId,
    },
  });
  await db.contract.create({
    data: {
      workspaceId: ws,
      accountId: northgate.id,
      startDate: new Date("2026-01-01"),
      renewalDate: new Date("2026-12-15"),
      valueMinor: 14_200_000n,
      currency: "USD",
      noticePeriodDays: 60,
    },
  });
  const play = await db.play.create({
    data: {
      workspaceId: ws,
      key: `rr-${randomUUID().slice(0, 6)}`,
      name: "Renewal Risk",
      status: "PUBLISHED",
    },
  });
  const v = await db.playVersion.create({
    data: {
      workspaceId: ws,
      playId: play.id,
      version: 1,
      definition: { steps: [] },
      publishedAt: new Date(),
    },
  });
  await db.play.update({ where: { id: play.id }, data: { currentVersionId: v.id } });
  playId = play.id;
});

describe("askQuestion", () => {
  it("answers from the asker's tool results with one AgentRun and stored citations", async () => {
    const res = await askQuestion(
      admin,
      { question: "What is Northgate Freight's contract value?" },
      {
        provider: provider(
          [{ tool: "getContract", input: { accountId: northgate.id } }],
          (records) => {
            const c = records.find((r) => r.sourceType === "Contract")!;
            return {
              ...base,
              answer: "Northgate Freight's contract is worth $142,000 and renews on 2026-12-15.",
              citations: [{ sourceType: "Contract", sourceId: c.sourceId }],
              figures: [
                {
                  value: "142000.00",
                  sourceType: "Contract",
                  sourceId: c.sourceId,
                  field: "value",
                },
              ],
            };
          },
        ),
      },
    );
    expect(res.status).toBe("SUCCEEDED");
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: res.runId! } });
    expect(run).toMatchObject({
      agentKey: "ask-ai",
      promptName: "ask-ai",
      promptVersion: "1.0.0",
      status: "SUCCEEDED",
    });
    expect(run.model).toBe("test-model");
    expect(JSON.stringify(run.inputRefs)).toContain("Contract");
    const { messages } = await getThread(admin, res.threadId);
    expect(messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT"]);
    expect(messages[1]!.agentRunId).toBe(run.id);
    expect(messages[1]!.content).toContain("142,000");
    expect(JSON.stringify(messages[1]!.citations)).toContain("Contract for Northgate Freight");
  });

  it("records the planning steps' tokens on the answer's run, apart from the answer's own", async () => {
    // Two planning calls (one asks for a tool, one says "answer") then the answer: the provider
    // reports 10 in / 5 out for every call. Planning is counted so the monthly AI budget sees it.
    const res = await askQuestion(
      admin,
      { question: "What is Northgate Freight's contract value?" },
      {
        provider: provider(
          [{ tool: "getContract", input: { accountId: northgate.id } }],
          (records) => {
            const c = records.find((r) => r.sourceType === "Contract")!;
            return {
              ...base,
              answer: "Northgate Freight's contract is worth $142,000.",
              citations: [{ sourceType: "Contract", sourceId: c.sourceId }],
              figures: [
                {
                  value: "142000.00",
                  sourceType: "Contract",
                  sourceId: c.sourceId,
                  field: "value",
                },
              ],
            };
          },
        ),
      },
    );
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: res.runId! } });
    expect(run.inputTokens).toBe(10); // the answer call only
    expect(run.outputTokens).toBe(5);
    expect(run.planningInputTokens).toBe(20); // two planning calls
    expect(run.planningOutputTokens).toBe(10);
  });

  it("an account with no contract: the answer says it cannot see one, citing what it did see", async () => {
    const res = await askQuestion(
      admin,
      { question: "What is Fairhaven Dental's contract value?" },
      {
        provider: provider(
          [
            { tool: "getContract", input: { accountId: fairhaven.id } },
            { tool: "getAccount360Summary", input: { accountId: fairhaven.id } },
          ],
          (records) => {
            const a = records.find((r) => r.sourceType === "Account")!;
            return {
              ...base,
              answer: "I cannot see a contract for Fairhaven Dental.",
              citations: [{ sourceType: "Account", sourceId: a.sourceId }],
            };
          },
        ),
      },
    );
    expect(res.status).toBe("SUCCEEDED");
    const { messages } = await getThread(admin, res.threadId);
    expect(messages[1]!.content).toBe("I cannot see a contract for Fairhaven Dental.");
  });

  it("a number in no cited record makes the run UNCITED; no AI text is stored", async () => {
    const res = await askQuestion(
      admin,
      { question: "How much is Northgate worth?" },
      {
        provider: provider(
          [{ tool: "getContract", input: { accountId: northgate.id } }],
          (records) => {
            const c = records.find((r) => r.sourceType === "Contract")!;
            return {
              ...base,
              answer: "It is worth $175,000.",
              citations: [{ sourceType: "Contract", sourceId: c.sourceId }],
            };
          },
        ),
      },
    );
    expect(res.status).toBe("UNCITED");
    const { messages } = await getThread(admin, res.threadId);
    expect(messages[1]!.content).not.toContain("175");
    expect(messages[1]!.agentRunId).toBe(res.runId);
  });

  it("a member without revenue access never receives the contract value", async () => {
    const leader = await member("CS_LEADER", false);
    const res = await askQuestion(
      leader,
      { question: "What is Northgate Freight's contract value?" },
      {
        provider: provider(
          [{ tool: "getContract", input: { accountId: northgate.id } }],
          (records) => {
            const c = records.find((r) => r.sourceType === "Contract")!;
            expect(JSON.stringify(c.fields)).not.toContain("142000");
            return {
              ...base,
              answer: "Northgate Freight's contract is worth $142,000.",
              citations: [{ sourceType: "Contract", sourceId: c.sourceId }],
            };
          },
        ),
      },
    );
    expect(res.status).toBe("UNCITED");
  });

  it("a requested change becomes a PENDING Approval with the change list and changes nothing", async () => {
    const res = await askQuestion(
      admin,
      { question: "Move Northgate Freight to the Renewal Risk play" },
      {
        provider: provider(
          [
            { tool: "listPlays", input: {} },
            { tool: "getAccount360Summary", input: { accountId: northgate.id } },
          ],
          (records) => {
            const a = records.find((r) => r.sourceType === "Account")!;
            const p = records.find((r) => r.sourceType === "Play")!;
            return {
              ...base,
              answer: "I prepared the enrolment for your approval.",
              citations: [
                { sourceType: "Account", sourceId: a.sourceId },
                { sourceType: "Play", sourceId: p.sourceId },
              ],
              proposal: {
                reason: "Asked to move Northgate Freight to Renewal Risk",
                items: [{ kind: "ENROLL_PLAY", accountId: a.sourceId, playId: p.sourceId }],
              },
            };
          },
        ),
      },
    );
    expect(res.status).toBe("SUCCEEDED");
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: res.runId! } });
    const effects = run.effects as Array<{ type: string; id: string }>;
    const approvalId = effects.find((e) => e.type === "Approval")!.id;
    const approval = await db.approval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(approval).toMatchObject({
      status: "PENDING",
      kind: "ENROLL_PLAY",
      proposedByAgentRunId: run.id,
    });
    expect(await db.playRun.count({ where: { accountId: northgate.id, playId } })).toBe(0);
  });

  it("an invented account id in a proposal is never proposed", async () => {
    const res = await askQuestion(
      admin,
      { question: "Enrol them all" },
      {
        provider: provider([{ tool: "listPlays", input: {} }], (records) => {
          const p = records.find((r) => r.sourceType === "Play")!;
          return {
            ...base,
            answer: "Prepared.",
            citations: [{ sourceType: "Play", sourceId: p.sourceId }],
            proposal: {
              reason: "x",
              items: [{ kind: "ENROLL_PLAY", accountId: fairhaven.id, playId: p.sourceId }],
            },
          };
        }),
      },
    );
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: res.runId! } });
    expect(run.effects ?? []).toEqual([]);
  });

  it("a conversation belongs to its user: another member, or another workspace, cannot read it", async () => {
    const res = await askQuestion(
      admin,
      { question: "Hello?" },
      { provider: provider([], () => ({ ...base, answer: "x", citations: [] })) },
    );
    const other = await member("CS_LEADER", true);
    await expect(getThread(other, res.threadId)).rejects.toThrow(/not found/i);
    const { actor: b } = await createTestAdmin("AskLoopB");
    await expect(getThread(b, res.threadId)).rejects.toThrow(/not found/i);
    await expect(
      askQuestion(
        other,
        { question: "continue", threadId: res.threadId },
        { provider: provider([], () => ({})) },
      ),
    ).rejects.toThrow(/not found/i);
  });
});
