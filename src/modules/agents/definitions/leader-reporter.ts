import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { defineAgent, type BuiltContext } from "../define";
import { baseAgentOutput, citationSchema, type ContextBundle } from "../schemas";

/**
 * Leader Reporter (M11 S7, spec §5 Reports, ARCHITECTURE §6.2 row 13): the weekly digest for the
 * CS leaders, written ONLY from the computed ReportSnapshot figures it is given (D-75: no model
 * produces a number; D-164: a date is digits like any other figure and must appear in a cited
 * record). Money figures are left out of what the agent reads, so one narrative is safe for every
 * recipient whatever their revenue access; money is shown only in the linked in-app reports.
 */
export const leaderReporterInput = z.object({
  /** The week's snapshots, fixed set: workspace-wide (ALL scope) reports. */
  snapshotIds: z.array(z.string().min(1)).min(1).max(10),
});
export type LeaderReporterInput = z.infer<typeof leaderReporterInput>;

export const leaderReporterOutput = z.object({
  ...baseAgentOutput.shape,
  items: z
    .array(
      z.object({
        text: z.string().min(1).max(700),
        citations: z.array(citationSchema).min(1),
      }),
    )
    .min(1)
    .max(10),
});
export type LeaderReporterOutput = z.infer<typeof leaderReporterOutput>;

/** The id a figure is cited by: `<snapshotId>#sections.<s>.figures.<f>` (sourceType ReportSnapshot). */
export const figureSourceId = (snapshotId: string, s: number, f: number) =>
  `${snapshotId}#sections.${s}.figures.${f}`;

interface StoredFigure {
  label: string;
  value: number | string | null;
  unit: string;
  reason?: string;
}
interface StoredData {
  periodStart?: string;
  periodEnd?: string;
  accountsInScope?: number;
  sections?: Array<{ title: string; figures: StoredFigure[] }>;
}

export const leaderReporter = defineAgent({
  key: "leader-reporter",
  version: "1.0.0",
  description:
    "Writes the weekly digest for the CS leaders from the computed report figures, every sentence citing the figures it uses",
  modelTier: "standard",
  tierReason: "A short, accurate summary of already-computed figures; no deep reasoning needed.",
  prompt: { name: "leader-reporter", version: "1.0.0" },
  forbiddenNumericFields: [],
  approvalPolicy: "INTERNAL",
  inputSchema: leaderReporterInput,
  outputSchema: leaderReporterOutput,

  async buildContext(db, input): Promise<BuiltContext> {
    const rows = await db.reportSnapshot.findMany({
      where: { id: { in: input.snapshotIds } },
      orderBy: [{ reportKey: "asc" }, { id: "asc" }],
    });
    if (rows.length !== new Set(input.snapshotIds).size)
      throw new Error(
        "The digest was given a report snapshot that does not exist in this workspace",
      );
    const bundle: ContextBundle = [];
    for (const row of rows) {
      const data = row.data as unknown as StoredData;
      bundle.push({
        sourceType: "ReportSnapshot",
        sourceId: row.id,
        fields: {
          report: row.reportKey,
          periodStart: data.periodStart ?? null,
          periodEnd: data.periodEnd ?? null,
          accountsInScope: data.accountsInScope ?? null,
        },
      });
      (data.sections ?? []).forEach((section, s) =>
        section.figures.forEach((fig, f) => {
          // Money never reaches the model: the digest goes to people with and without revenue access.
          if (fig.unit === "money") return;
          bundle.push({
            sourceType: "ReportSnapshot",
            sourceId: figureSourceId(row.id, s, f),
            fields: {
              report: row.reportKey,
              section: section.title,
              label: fig.label,
              value: fig.value,
              unit: fig.unit,
              reason: fig.value === null ? (fig.reason ?? "No data") : null,
            },
          });
        }),
      );
    }
    return { bundle, vars: {} };
  },

  extraCitations: (output) => output.items.flatMap((i) => i.citations),
  narrative: (output) => output.items.map((i) => i.text),

  async act(_output, ctx) {
    const input = leaderReporterInput.parse(ctx.input);
    // NULL -> run id, once (the database refuses any other change to the link).
    await ctx.db.reportSnapshot.updateMany({
      where: { id: { in: input.snapshotIds }, digestAgentRunId: null },
      data: { digestAgentRunId: ctx.runId } satisfies Prisma.ReportSnapshotUncheckedUpdateManyInput,
    });
    return {
      effects: input.snapshotIds.map((id) => ({ type: "ReportSnapshot", id })),
      actionTaken: "EXECUTED",
    };
  },
});
