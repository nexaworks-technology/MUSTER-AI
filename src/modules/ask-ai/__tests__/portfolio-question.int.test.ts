import { randomUUID } from "node:crypto";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { AiProvider, StructuredRequest } from "@/lib/ai";
import { loadPrompt } from "@/lib/ai";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import { askAi, evaluateOutput } from "@/modules/agents/service";
import { constrainToSchema } from "@/test/constrain-schema";
import { createTestAdmin } from "@/test/fixtures";
import { askQuestion } from "../service";
import { runAskTool } from "../tools";

/**
 * FIX-2026-11-11-ASK2 items 1 and 2. A portfolio question is answered from ONE deterministic tool
 * (band counts plus the Watch and At Risk accounts with their reasons), and the answer step can
 * cite only records returned in THIS run. Evidence: run cmwc0e4g8000hnx0ybyufhfti was UNCITED after
 * 10 tool calls because the model copied a record's 25-character id wrongly (kept the first 17
 * characters, invented the tail) and cited an account it had never been given as a record.
 */
async function modelFor(db: ScopedDb, ws: string) {
  return (
    (await db.healthModel.findFirst({ where: { status: "ACTIVE" } })) ??
    (await db.healthModel.create({
      data: {
        workspaceId: ws,
        version: 1,
        status: "ACTIVE",
        proposedBy: "SYSTEM_DEFAULT",
        pillarWeights: {},
        componentConfig: {},
        thresholds: { healthyMin: 70, watchMin: 45 },
      },
    }))
  );
}

async function scored(
  db: ScopedDb,
  ws: string,
  name: string,
  level: "AT_RISK" | "WATCH" | "HEALTHY",
  overall: number,
  reason: string,
) {
  const model = await modelFor(db, ws);
  const a = await db.account.create({ data: { workspaceId: ws, name, tier: "MID_TOUCH" } });
  const snapshotId = randomUUID();
  const reasonId = randomUUID();
  await db.$tenantTransaction(async (tx) => {
    await tx.healthScoreSnapshot.create({
      data: {
        id: snapshotId,
        workspaceId: ws,
        accountId: a.id,
        healthModelId: model.id,
        asOf: new Date("2026-11-10"),
        overall,
        adoption: overall,
        riskLevel: level,
        riskLevelExcludingPulse: level,
        riskReasonId: level === "AT_RISK" ? reasonId : null,
        effectiveWeights: {},
        inputsHash: snapshotId,
      },
    });
    await tx.healthReason.create({
      data: {
        id: reasonId,
        workspaceId: ws,
        snapshotId,
        pillar: "ADOPTION",
        component: "c",
        kind: "EVIDENCE",
        direction: "DOWN",
        impact: -10,
        input: "i",
        message: reason,
        sources: [{ sourceType: "Account", sourceId: a.id }],
      },
    });
    await tx.account.update({ where: { id: a.id }, data: { currentHealthSnapshotId: snapshotId } });
  });
  return { accountId: a.id, snapshotId, name };
}

async function world(label: string, extraAtRisk = 0) {
  const { actor, workspace } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = workspace.id;
  const zenith = await scored(
    db,
    ws,
    "Zenith Foods",
    "AT_RISK",
    31.5,
    "Weekday active users fell from 41 to 17",
  );
  const quartz = await scored(db, ws, "Quartz Ltd", "WATCH", 52, "Feature adoption is flat at 12%");
  await scored(db, ws, "Calm Inc", "HEALTHY", 91, "Usage is above its normal");
  for (let i = 0; i < extraAtRisk; i++)
    await scored(
      db,
      ws,
      `Extra ${String(i).padStart(2, "0")}`,
      "AT_RISK",
      20 + i,
      `Reason number ${i}`,
    );
  // A real account that no tool in these runs ever returns as a record (it is not scored).
  const bystander = await db.account.create({
    data: { workspaceId: ws, name: "Bystander Inc", tier: "MID_TOUCH" },
  });
  return { actor, db, zenith, quartz, bystander };
}

describe("getPortfolioHealth: one call returns the bands and the accounts in them, with reasons", () => {
  it("returns a counts record and one health record per Watch / At Risk account, with stable refs", async () => {
    const w = await world("PortTool");
    const out = await runAskTool(w.actor, "getPortfolioHealth", {});
    expect(out.notFound).toBeNull();
    const [summary, ...accounts] = out.records;
    expect(summary).toMatchObject({ type: "PortfolioHealth", href: "/health" });
    expect(summary!.fields).toMatchObject({
      asOf: "2026-11-10",
      atRisk: 1,
      watch: 1,
      healthy: 1,
      notEnoughData: 0,
      accountsInBands: 2,
    });
    expect(
      accounts.map((r) => [r.type, r.id, r.fields.accountName, r.fields.band, r.fields.score]),
    ).toEqual([
      ["HealthScoreSnapshot", w.zenith.snapshotId, "Zenith Foods", "AT_RISK", 31.5],
      ["HealthScoreSnapshot", w.quartz.snapshotId, "Quartz Ltd", "WATCH", 52],
    ]);
    expect(accounts[0]!.ref).toBe(`HealthScoreSnapshot:${w.zenith.snapshotId}`);
    expect(accounts[0]!.fields.accountId).toBe(w.zenith.accountId);
    expect(accounts[0]!.fields.reason1).toBe("Weekday active users fell from 41 to 17");
    expect(new Set(out.records.map((r) => r.ref)).size).toBe(out.records.length);
    expect(out.note ?? null).toBeNull();
  });

  it("always returns both bad bands: a book with no At Risk accounts still lists its Watch account (the live failure)", async () => {
    // The first live run passed band AT_RISK on a book with 0 At Risk and 1 Watch, got no accounts back
    // and could not name the Watch one. The tool has no filter to under-fetch with: a `band` argument
    // from a planner is ignored.
    const { actor, workspace } = await createTestAdmin("PortToolWatchOnly");
    const db = scopedDb(actor);
    const quartz = await scored(
      db,
      workspace.id,
      "Quartz Ltd",
      "WATCH",
      52,
      "Feature adoption is flat at 12%",
    );
    const out = await runAskTool(actor, "getPortfolioHealth", { band: "AT_RISK" });
    expect(out.records[0]!.fields).toMatchObject({ atRisk: 0, watch: 1, accountsInBands: 1 });
    expect(out.records.filter((r) => r.type === "HealthScoreSnapshot").map((r) => r.id)).toEqual([
      quartz.snapshotId,
    ]);
  });

  it("says plainly when the list was cut at 10 of 15", async () => {
    const w = await world("PortToolCut", 13);
    const all = await runAskTool(w.actor, "getPortfolioHealth", {});
    expect(all.records.filter((r) => r.type === "HealthScoreSnapshot")).toHaveLength(10);
    expect(all.records[0]!.fields).toMatchObject({ accountsInBands: 15, accountsListed: 10 });
    expect(all.note).toMatch(/10 lowest-scoring of 15/);
    expect(all.note).toMatch(/not the full list/i);
  });

  it("says so when nothing is scored yet, instead of reporting an empty, healthy book", async () => {
    const { actor } = await createTestAdmin("PortToolNone");
    const out = await runAskTool(actor, "getPortfolioHealth", {});
    expect(out.records).toEqual([]);
    expect(out.notFound).toMatch(/no health score yet/i);
  });
});

type Variant =
  "valid-alias" | "valid-real" | "alias-outside" | "real-outside" | "mangled" | "number";

interface Rec {
  cite?: string;
  sourceType: string;
  sourceId: string;
  fields: Record<string, unknown>;
}

/** A model whose planning output is constrained to the schema, as the live API is. */
function provider(
  variant: Variant,
  w: Awaited<ReturnType<typeof world>>,
  seen: { plans: number; answers: StructuredRequest<unknown>[] },
): AiProvider {
  return {
    name: "recorded",
    async generateStructured<T>(req: StructuredRequest<T>) {
      let output: unknown;
      if (req.promptRef.startsWith("ask-ai-plan@")) {
        seen.plans++;
        const step = (JSON.parse(req.input) as { step: number }).step;
        output = constrainToSchema(
          step === 1
            ? { action: "call", calls: [{ tool: "getPortfolioHealth", input: {} }] }
            : { action: "answer" },
          zodOutputFormat(req.schema as z.ZodType).schema as never,
        );
      } else {
        seen.answers.push(req as StructuredRequest<unknown>);
        const bundle = JSON.parse(req.input.slice(req.input.indexOf("["))) as Rec[];
        const zen = bundle.find((r) => r.sourceId === w.zenith.snapshotId)!;
        const quartz = bundle.find((r) => r.sourceId === w.quartz.snapshotId)!;
        const summary = bundle.find((r) => r.sourceType === "PortfolioHealth")!;
        const cite = (r: Rec) => ({ sourceType: r.sourceType, sourceId: r.cite ?? r.sourceId });
        let citations: Array<{ sourceType: string; sourceId: string }> = [
          cite(zen),
          cite(quartz),
          cite(summary),
        ];
        if (variant === "valid-real")
          citations = [zen, quartz, summary].map((r) => ({
            sourceType: r.sourceType,
            sourceId: r.sourceId,
          }));
        if (variant === "alias-outside")
          citations = [...citations, { sourceType: "Signal", sourceId: "R99" }];
        if (variant === "real-outside")
          citations = [...citations, { sourceType: "Account", sourceId: w.bystander.id }];
        if (variant === "mangled")
          citations = [
            {
              sourceType: "HealthScoreSnapshot",
              sourceId: `${w.zenith.snapshotId.slice(0, 17)}t9xqlyca8`,
            },
            cite(quartz),
            cite(summary),
          ];
        output = {
          reasoningSummary: "Read the portfolio health records.",
          confidence: 0.8,
          proposedActions: [],
          answer:
            variant === "number"
              ? "Zenith Foods is At Risk: Weekday active users fell from 41 to 17. 56 accounts are scored."
              : "Zenith Foods is At Risk (score 31.5): Weekday active users fell from 41 to 17. Quartz Ltd is on Watch (score 52): Feature adoption is flat at 12%.",
          citations,
          figures: [],
        };
      }
      return {
        output: (req.schema as z.ZodType).parse(output) as T,
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

const ask = async (variant: Variant, label: string) => {
  const w = await world(label);
  const seen = { plans: 0, answers: [] as StructuredRequest<unknown>[] };
  const res = await askQuestion(
    w.actor,
    { question: "Which accounts are at risk and why?" },
    { provider: provider(variant, w, seen) },
  );
  const run = await w.db.agentRun.findUniqueOrThrow({ where: { id: res.runId! } });
  return { w, seen, res, run };
};

describe("which accounts are at risk and why: one tool call, an answer that resolves", () => {
  it("answers with ONE tool call, names the Watch / At Risk accounts with reasons, and every citation is a record the run was given", async () => {
    const { w, seen, res, run } = await ask("valid-alias", "PortAsk");
    expect(res.status).toBe("SUCCEEDED");
    const msg = await w.db.askMessage.findFirstOrThrow({
      where: { role: "ASSISTANT", agentRunId: run.id },
    });
    const steps = (msg.toolCalls as { steps: Array<{ tool: string }> }).steps;
    expect(steps.map((s) => s.tool)).toEqual(["getPortfolioHealth"]); // not ten exploratory calls
    expect(seen.plans).toBe(2); // one call, then "answer"
    expect(msg.content).toContain("Zenith Foods is At Risk");
    expect(msg.content).toContain("Weekday active users fell from 41 to 17");
    expect(msg.content).toContain("Quartz Ltd is on Watch");
    // Every stored citation resolves to a record this run was given (real ids, not aliases).
    const given = new Set((run.inputRefs as Array<{ sourceId: string }>).map((r) => r.sourceId));
    const cited = (run.citations as Array<{ sourceId: string }>).map((c) => c.sourceId);
    expect(cited.length).toBeGreaterThanOrEqual(3);
    for (const id of cited)
      expect(given.has(id), `cited ${id} was not given to the run`).toBe(true);
    expect(cited).toContain(w.zenith.snapshotId);
    expect(run.status).toBe("SUCCEEDED");
  });

  it("the answer step is shown each record's short cite handle", async () => {
    const { seen } = await ask("valid-alias", "PortHandles");
    const bundle = JSON.parse(
      seen.answers[0]!.input.slice(seen.answers[0]!.input.indexOf("[")),
    ) as Rec[];
    expect(bundle.map((r) => r.cite)).toEqual(bundle.map((_, i) => `R${i + 1}`));
    expect(seen.answers[0]!.system).toMatch(/cite/i);
  });

  it("citing a real record id still works (the handle is a convenience, not a new requirement)", async () => {
    const { res } = await ask("valid-real", "PortReal");
    expect(res.status).toBe("SUCCEEDED");
  });
});

describe("the answer step cannot cite a ref outside this run's record set (guard unchanged)", () => {
  it.each([
    ["a handle that matches no record (R99)", "alias-outside"],
    ["a real account id that this run was never given as a record", "real-outside"],
    ["a mangled id: the right first 17 characters and an invented tail", "mangled"],
  ] as const)("%s → UNCITED, nothing stored as an answer", async (_name, variant) => {
    const { w, res, run } = await ask(variant, `PortGuard${variant}`);
    expect(res.status).toBe("UNCITED");
    expect(run.status).toBe("UNCITED");
    expect(run.output).toBeNull();
    expect(run.errorDetail).toMatch(/which the run was not given/);
    const msg = await w.db.askMessage.findFirstOrThrow({
      where: { role: "ASSISTANT", agentRunId: run.id },
    });
    expect(msg.content).toBe("I could not answer that with sources I can show you.");
  });

  it("a numbered list is refused when a list numeral is in no cited record (the guard counts every number), so the prompt forbids numbering", async () => {
    // Live run cmwc198of0005rf1hyqyw393u was UNCITED for exactly this: the answer numbered its
    // reasons 1. 2. 3. and the number "3" is in no cited record. The guard's number check matches any
    // digit run, so a list numeral passes or fails by chance (digits inside a record's random ids
    // count), which is why it was intermittent. The guard is right and unchanged; the answer's format
    // was the problem, so the prompt forbids numbering. Fixed record: no "3" anywhere in it.
    const record = {
      sourceType: "HealthScoreSnapshot",
      sourceId: "snap-fixed",
      fields: {
        label: "Health of Brightwell Logistics on 2026-11-11",
        score: 67.12,
        reason1: "31 of 207 seats were used in the last 28 days (15%).",
        reason2: "Champion Maya Ortiz: email bounced (Oct 27, 2026).",
      },
    };
    const output = (answer: string) => ({
      reasoningSummary: "Read the snapshot.",
      confidence: 0.9,
      proposedActions: [],
      answer,
      citations: [{ sourceType: record.sourceType, sourceId: record.sourceId }],
      figures: [],
    });
    const numbered = evaluateOutput(
      askAi,
      [record],
      output(
        "Brightwell Logistics is on Watch:\n1. Low seat use.\n2. A bounced champion email.\n3. Low survey scores.",
      ),
    );
    expect(numbered).toMatchObject({ status: "UNCITED" });
    expect((numbered as { problems: string[] }).problems.join(" ")).toMatch(
      /the number "3" is not in any record it cites/,
    );
    const plain = evaluateOutput(
      askAi,
      [record],
      output(
        "Brightwell Logistics is on Watch. Seats: 31 of 207 seats were used in the last 28 days (15%). Its champion's email bounced.",
      ),
    );
    expect(plain).toMatchObject({ status: "SUCCEEDED" });
    const prompt = await loadPrompt("ask-ai", askAi.prompt.version);
    expect(prompt.body).toMatch(/do not number/i);
    expect(prompt.body).toMatch(/numbered list/i);
  });

  it("a number that is in no cited record is still refused", async () => {
    const { res, run } = await ask("number", "PortNumber");
    expect(res.status).toBe("UNCITED");
    expect(run.errorDetail).toMatch(/the number "56" is not in any record it cites/);
  });
});
