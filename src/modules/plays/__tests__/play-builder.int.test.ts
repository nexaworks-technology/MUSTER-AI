import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { AiProvider } from "@/lib/ai";
import { scopedDb } from "@/lib/db/scoped";
import { playBuilder, runAgent } from "@/modules/agents/service";
import { publishPlay } from "@/modules/plays/service";
import { createTestAdmin } from "@/test/fixtures";
import type { PlayDefinition } from "../definition";

const safeGeneratedDef: PlayDefinition = {
  name: "Generated Retention Check",
  description: "Automated check for high-risk accounts",
  trigger: { type: "signal", ruleKey: "usage_drop" },
  steps: [
    {
      key: "task-followup",
      name: "Follow up with owner",
      handler: "task",
      params: { title: "Follow up on usage drop" },
      approvalLevelByTier: {
        HIGH_TOUCH: "NOTIFY_ONLY",
        MID_TOUCH: "NOTIFY_ONLY",
        LONG_TAIL: "NOTIFY_ONLY",
      },
      safe: true,
      sensitive: false,
    },
  ],
};

const unsafeGeneratedDef: PlayDefinition = {
  name: "Unsafe Auto-Cancellation Play",
  description: "Attempts automated sending on sensitive topic",
  trigger: { type: "noteTag", tag: "cancellation-risk" },
  steps: [
    {
      key: "auto-send-sensitive",
      name: "Send cancellation response",
      handler: "send",
      params: { templateSubject: "Cancellation confirmation", templateBody: "Sorry to see you go." },
      approvalLevelByTier: {
        HIGH_TOUCH: "SEND_AUTOMATICALLY",
        MID_TOUCH: "SEND_AUTOMATICALLY",
        LONG_TAIL: "SEND_AUTOMATICALLY",
      },
      safe: false,
      sensitive: true,
    },
  ],
};

describe("S10: Play Builder Agent & Safety Gate Integration (D-138, spec §5)", () => {
  it("plain words description produces a structured PlayDefinition and saves only as DRAFT", async () => {
    const { actor: admin } = await createTestAdmin("PlayBuilderDraftWS");
    const db = scopedDb(admin);

    const mockProvider: AiProvider = {
      name: "recorded",
      async generateStructured<T>() {
        return {
          output: {
            name: "Generated Retention Check",
            description: "Automated check for high-risk accounts",
            category: "RETENTION",
            definition: safeGeneratedDef,
            reasoningSummary: "Synthesized a standard task-based workflow triggered by usage drop.",
            confidence: 0.95,
            citations: [{ sourceType: "UserPrompt", sourceId: "prompt" }],
            proposedActions: [],
          } as unknown as T,
          stopReason: "end_turn",
          model: "mock-model",
          requestId: null,
          inputTokens: 25,
          outputTokens: 50,
          latencyMs: 2,
        };
      },
    };

    const out = await runAgent(
      admin,
      playBuilder,
      {
        userPrompt: "When usage drops on an account, create a task for the CSM to follow up.",
      },
      { type: "manual", id: `trig-${Date.now()}` },
      { provider: mockProvider },
    );

    expect(out.kind).toBe("run");
    if (out.kind !== "run") throw new Error("not run");
    expect(out.status).toBe("SUCCEEDED");

    const run = await db.agentRun.findUniqueOrThrow({ where: { id: out.runId } });
    expect(run.agentKey).toBe("play-builder");
    expect(run.actionTaken).toBe("DRAFTED");

    const effects = run.effects as Array<{ type: string; id: string }>;
    const playEffect = effects.find((e) => e.type === "Play");
    const versionEffect = effects.find((e) => e.type === "PlayVersion");
    expect(playEffect).toBeDefined();
    expect(versionEffect).toBeDefined();

    // Invariant: Builder saves strictly as DRAFT; it NEVER publishes
    const play = await db.play.findUniqueOrThrow({ where: { id: playEffect!.id } });
    expect(play.status).toBe("DRAFT");
    expect(play.isSeeded).toBe(false);

    const version = await db.playVersion.findUniqueOrThrow({ where: { id: versionEffect!.id } });
    expect(version.version).toBe(1);
    expect(version.publishedAt).toBeNull();
    expect((version.safetyCheck as { passed?: boolean })?.passed).toBe(true);

    // Rule 5 compliance
    expect(run.promptVersion).toBe("1.0.0");
    expect(run.confidence).toBe(0.95);
    expect(run.reasoningSummary).toContain("Synthesized a standard task-based workflow");
  });

  it("builder-produced draft faces the exact same pre-publish safety gate (proven by test)", async () => {
    const { actor: admin } = await createTestAdmin("PlayBuilderGateWS");
    const db = scopedDb(admin);

    // 1. Builder generates an UNSAFE play (auto-send on sensitive step)
    const mockUnsafeProvider: AiProvider = {
      name: "recorded",
      async generateStructured<T>() {
        return {
          output: {
            name: "Unsafe Auto-Cancellation Play",
            description: "Attempts automated sending on sensitive topic",
            category: "RETENTION",
            definition: unsafeGeneratedDef,
            reasoningSummary: "Attempted auto-send on sensitive cancellation topic.",
            confidence: 0.8,
            citations: [{ sourceType: "UserPrompt", sourceId: "prompt" }],
            proposedActions: [],
          } as unknown as T,
          stopReason: "end_turn",
          model: "mock-model",
          requestId: null,
          inputTokens: 20,
          outputTokens: 40,
          latencyMs: 2,
        };
      },
    };

    const outUnsafe = await runAgent(
      admin,
      playBuilder,
      {
        userPrompt: "Whenever a cancellation note is added, immediately auto-send a farewell email without asking anyone.",
      },
      { type: "manual", id: `trig-${Date.now()}` },
      { provider: mockUnsafeProvider },
    );

    expect(outUnsafe.kind).toBe("run");
    if (outUnsafe.kind !== "run") throw new Error("not run");

    const runUnsafe = await db.agentRun.findUniqueOrThrow({ where: { id: outUnsafe.runId } });
    const effectsUnsafe = runUnsafe.effects as Array<{ type: string; id: string }>;
    const unsafePlayId = effectsUnsafe.find((e) => e.type === "Play")!.id;

    // Safety gate refuses publishing this builder draft!
    const publishResult = await publishPlay(admin, unsafePlayId);
    expect(publishResult.status).toBe("REFUSED");
    if (publishResult.status === "REFUSED") {
      expect(
        publishResult.refusals.some((r) => r.includes("Sensitive step") || r.includes("SEND_AUTOMATICALLY")),
      ).toBe(true);
    }

    // Play remains in DRAFT status
    const playAfterRefusal = await db.play.findUniqueOrThrow({ where: { id: unsafePlayId } });
    expect(playAfterRefusal.status).toBe("DRAFT");
  });

  it("updating an existing play creates a new version incremented, still in DRAFT", async () => {
    const { workspace, actor: admin } = await createTestAdmin("PlayBuilderUpdateWS");
    const db = scopedDb(admin);

    const existingPlay = await db.play.create({
      data: {
        workspaceId: workspace.id,
        key: "existing-builder-play",
        name: "Initial Play",
        status: "DRAFT",
      },
    });
    await db.playVersion.create({
      data: {
        workspaceId: workspace.id,
        playId: existingPlay.id,
        version: 1,
        definition: safeGeneratedDef as unknown as Prisma.InputJsonValue,
      },
    });

    const mockUpdateProvider: AiProvider = {
      name: "recorded",
      async generateStructured<T>() {
        return {
          output: {
            name: "Updated Play Name",
            description: "Updated description",
            category: "RETENTION",
            definition: { ...safeGeneratedDef, name: "Updated Play Name" },
            reasoningSummary: "Updated version with improved task details.",
            confidence: 0.9,
            citations: [{ sourceType: "UserPrompt", sourceId: "prompt" }],
            proposedActions: [],
          } as unknown as T,
          stopReason: "end_turn",
          model: "mock-model",
          requestId: null,
          inputTokens: 30,
          outputTokens: 50,
          latencyMs: 2,
        };
      },
    };

    const out = await runAgent(
      admin,
      playBuilder,
      {
        playId: existingPlay.id,
        userPrompt: "Update the play name and details.",
      },
      { type: "manual", id: `trig-${Date.now()}` },
      { provider: mockUpdateProvider },
    );

    expect(out.kind).toBe("run");
    if (out.kind !== "run") throw new Error("not run");
    expect(out.status).toBe("SUCCEEDED");

    const versions = await db.playVersion.findMany({
      where: { playId: existingPlay.id },
      orderBy: { version: "asc" },
    });
    expect(versions).toHaveLength(2);
    expect(versions[1]!.version).toBe(2);

    const updatedPlay = await db.play.findUniqueOrThrow({ where: { id: existingPlay.id } });
    expect(updatedPlay.status).toBe("DRAFT");
    expect(updatedPlay.currentVersionId).toBe(versions[1]!.id);
  });
});
