import { z } from "zod";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { formatCalendarDate } from "@/lib/format";
import { defineAgent } from "../define";
import { baseAgentOutput, type ContextBundle } from "../schemas";
import { jobTier } from "@/lib/ai/routing";

/**
 * Health Analyst (spec §6E2, ARCHITECTURE §6.2 #2): the top 1–2 risks or opportunities for one
 * account, in plain words, each citing the health reasons or signals behind it. Internal only:
 * it reads deterministic scores and never produces one (D-75).
 */
export const healthAnalystOutput = z.object({
  ...baseAgentOutput.shape,
  items: z
    .array(
      z.object({
        text: z.string().min(1).max(400),
        citesReasonIds: z.array(z.string()),
        citesSignalIds: z.array(z.string()),
      }),
    )
    .max(2),
});
export type HealthAnalystOutput = z.infer<typeof healthAnalystOutput>;

export const healthAnalystInput = z.object({
  accountId: z.string().min(1),
  snapshotId: z.string().min(1),
});

const RISK_WORDS = {
  HEALTHY: "Healthy",
  WATCH: "Watch",
  AT_RISK: "At Risk",
  INSUFFICIENT_DATA: "Not enough data",
} as const;
const day = (d: Date | string | null) =>
  d ? formatCalendarDate(typeof d === "string" ? new Date(`${d}T00:00:00Z`) : d) : null;
/** Scores and values arrive as numbers or Prisma Decimals; shown to one decimal, as on screen. */
const round1 = (x: { toString(): string } | number | null) =>
  x === null ? null : Math.round(Number(x) * 10) / 10;

export async function healthAnalystContext(
  ctx: TenantContext,
  input: z.infer<typeof healthAnalystInput>,
) {
  const db = scopedDb(ctx);
  const snapshot = await db.healthScoreSnapshot.findFirst({
    where: { id: input.snapshotId, accountId: input.accountId },
    include: {
      reasons: { orderBy: { sortOrder: "asc" } },
      account: { select: { id: true, name: true } },
    },
  });
  if (!snapshot) return { bundle: [] as ContextBundle, accountName: "", accountId: undefined };
  const signals = await db.signal.findMany({
    where: { accountId: snapshot.accountId, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
    orderBy: [{ severity: "desc" }, { firstSeenAt: "desc" }],
    take: 20,
  });
  const bundle: ContextBundle = [
    {
      sourceType: "HealthScoreSnapshot",
      sourceId: snapshot.id,
      fields: {
        account: snapshot.account.name,
        asOf: day(snapshot.asOf),
        overall: round1(snapshot.overall),
        level: RISK_WORDS[snapshot.riskLevel],
      },
    },
    ...snapshot.reasons.map((r) => ({
      sourceType: "HealthReason",
      sourceId: r.id,
      fields: {
        pillar: r.pillar.toLowerCase(),
        kind: r.kind === "MISSING_DATA" ? "missing data" : "evidence",
        message: r.message,
        value: round1(r.value),
        baseline: round1(r.baseline),
        // Named for what they are: the window the value was measured over, and what the baseline
        // is. A bare "period" read as the span of the change ("fell … in one week") when the
        // reason compares this week with the account's 90-day normal (DEMO-WALKTHROUGH).
        valueMeasuredOver:
          r.periodStart && r.periodEnd ? `${day(r.periodStart)} – ${day(r.periodEnd)}` : null,
        ...(r.baseline !== null
          ? {
              baselineIs:
                "what the message compares the value with (for usage, this account's own normal period named in the message), not the start of the measured window",
            }
          : {}),
      },
    })),
    ...signals.map((s) => ({
      sourceType: "Signal",
      sourceId: s.id,
      fields: {
        title: s.title,
        explanation: s.explanation,
        severity: s.severity.toLowerCase(),
        polarity: s.polarity.toLowerCase(),
        firstSeen: day(s.firstSeenAt),
      },
    })),
  ];
  return { bundle, accountName: snapshot.account.name, accountId: snapshot.accountId };
}

export const healthAnalyst = defineAgent({
  key: "health-analyst",
  version: "1.1.0",
  description:
    "Writes the top 1–2 risks or opportunities for an account from its health reasons and signals",
  modelTier: jobTier("health-analyst"),
  tierReason: "A short narrative from structured reasons: needs judgement, not depth (§6.1).",
  prompt: { name: "health-analyst", version: "1.1.0" },
  inputSchema: healthAnalystInput,
  outputSchema: healthAnalystOutput,
  async buildContext(_db, input, ctx) {
    const c = await healthAnalystContext(ctx, input);
    return {
      bundle: c.bundle,
      accountId: c.accountId,
      vars: { accountName: c.accountName || "this account" },
    };
  },
  extraCitations: (o) =>
    o.items.flatMap((i) => [
      ...i.citesReasonIds.map((id) => ({ sourceType: "HealthReason", sourceId: id })),
      ...i.citesSignalIds.map((id) => ({ sourceType: "Signal", sourceId: id })),
    ]),
  narrative: (o) => [...o.items.map((i) => i.text)],
  uncited: (o) =>
    o.items
      .filter((i) => i.citesReasonIds.length + i.citesSignalIds.length === 0)
      .map((i) => `the item "${i.text.slice(0, 60)}" cites no reason or signal`),
  forbiddenNumericFields: ["confidence", "amountMinor"],
  approvalPolicy: "INTERNAL",
});
