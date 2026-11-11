import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import { playDefinitionSchema, validatePlaySafety } from "@/modules/plays/service";
import { defineAgent } from "../define";
import { baseAgentOutput, type ContextBundle } from "../schemas";
import { jobTier } from "@/lib/ai/routing";

export const playBuilderInput = z.object({
  userPrompt: z.string().min(1).max(5000),
  playId: z.string().optional(),
  playName: z.string().optional(),
});
export type PlayBuilderInput = z.infer<typeof playBuilderInput>;

export const playBuilderOutput = z.object({
  ...baseAgentOutput.shape,
  name: z.string().min(1).max(200),
  description: z.string().max(1000).default(""),
  category: z.string().default("general"),
  definition: playDefinitionSchema,
});
export type PlayBuilderOutput = z.infer<typeof playBuilderOutput>;

export const playBuilder = defineAgent({
  key: "play-builder",
  version: "1.0.0",
  description:
    "Turns plain English into a structured draft play; never publishes directly and subject to safety gate (D-138)",
  modelTier: jobTier("play-builder"),
  tierReason: "Structured workflow reasoning and policy synthesis from natural language (§5, D-138).",
  prompt: { name: "play-builder", version: "1.0.0" },
  forbiddenNumericFields: [],
  inputSchema: playBuilderInput,
  outputSchema: playBuilderOutput,
  async buildContext(db, input) {
    // Collect active signal rules and segments in this workspace for grounding
    const [rules, segments] = await Promise.all([
      db.signalRule.findMany({
        where: { enabled: true },
        select: { ruleKey: true, category: true, meaning: true },
        take: 10,
      }),
      db.segment.findMany({
        select: { id: true, name: true },
        take: 10,
      }),
    ]);

    const bundle: ContextBundle = [
      {
        sourceType: "UserPrompt",
        sourceId: "prompt",
        fields: { text: input.userPrompt },
      },
      ...rules.map((r) => ({
        sourceType: "SignalRule",
        sourceId: r.ruleKey,
        fields: { meaning: r.meaning, category: r.category },
      })),
      ...segments.map((s) => ({
        sourceType: "Segment",
        sourceId: s.id,
        fields: { name: s.name },
      })),
    ];

    return {
      bundle,
      accountId: undefined,
      vars: {
        userPrompt: input.userPrompt,
        availableSignalRules: rules.map((r) => `${r.ruleKey} (${r.meaning})`).join(", ") || "None",
        availableSegments: segments.map((s) => `${s.id} (${s.name})`).join(", ") || "None",
      },
    };
  },
  narrative: (o) => [o.name, o.description],
  approvalPolicy: {
    HIGH_TOUCH: "NOTIFY_ONLY",
    MID_TOUCH: "NOTIFY_ONLY",
    LONG_TAIL: "NOTIFY_ONLY",
  },
  async act(output, ctx) {
    const input = ctx.input as PlayBuilderInput;

    // Perform safety check on the LLM-generated definition
    const safety = await validatePlaySafety(output.definition);

    const result = await ctx.db.$tenantTransaction(async (tx) => {
      let playId = input.playId;
      let play;
      let nextVersion = 1;

      if (playId) {
        play = await tx.play.findUnique({
          where: { id: playId },
          include: { versions: { orderBy: { version: "desc" }, take: 1 } },
        });
        if (!play) throw new Error("Play not found to update.");
        nextVersion = (play.versions[0]?.version ?? 0) + 1;
      } else {
        const key = `builder-${randomUUID().slice(0, 8)}`;
        play = await tx.play.create({
          data: {
            workspaceId: ctx.workspaceId,
            key,
            name: output.name,
            description: output.description,
            category: output.category,
            status: "DRAFT",
            isSeeded: false,
          },
        });
        playId = play.id;
      }

      const version = await tx.playVersion.create({
        data: {
          workspaceId: ctx.workspaceId,
          playId: play.id,
          version: nextVersion,
          definition: output.definition as unknown as Prisma.InputJsonValue,
          safetyCheck: { passed: safety.passed, refusals: safety.refusals },
        },
      });

      // Update play to point to currentVersion and ensure status remains DRAFT
      await tx.play.update({
        where: { id: play.id },
        data: {
          currentVersionId: version.id,
          status: "DRAFT",
        },
      });

      await writeAudit(
        {
          workspaceId: ctx.workspaceId,
          actorType: "SYSTEM",
          action: "play.builder_drafted",
          targetType: "Play",
          targetId: play.id,
          summary: `Play Builder created DRAFT play "${output.name}" v${nextVersion}`,
          after: {
            playId: play.id,
            version: nextVersion,
            safetyPassed: safety.passed,
          },
        },
        tx,
      );

      return { play, version };
    });

    return {
      effects: [
        { type: "Play", id: result.play.id },
        { type: "PlayVersion", id: result.version.id },
      ],
      actionTaken: "DRAFTED",
    };
  },
});
