import { z } from "zod";
import { businessClock } from "@/lib/dates";
import type { ScopedDb, TenantContext } from "@/lib/db/scoped";
import { formatCalendarDate } from "@/lib/format";
import { requestApproval } from "@/modules/approvals/service";
import { loadAdoption } from "@/modules/usage/service";
import { defineAgent } from "../define";
import { baseAgentOutput, proposedActionSchema, type ContextBundle } from "../schemas";
import { firstEmailContact } from "./draft-support";

/**
 * Adoption Coach (spec §6E5, M6 §2): for one account with an adoption signal, the unused-value
 * finding ("what they pay for and have not used", citing FeatureCatalog and FeatureUsageDaily
 * rows) and one nudge draft. The draft is an Approval at DRAFT_FOR_APPROVAL for every tier; it
 * never sends (Rule 3). Long-tail auto-send is only through plays in M8.
 *
 * Numbers (D-75): every count comes from `adoption.ts` and sits on the account record in the
 * bundle, so the narrative may repeat it and nothing else; no figure is the model's.
 */
const NUMERIC = ["confidence", "amountMinor", "days", "count", "percent"] as const;

export const adoptionCoachOutput = z.object({
  ...baseAgentOutput.shape,
  proposedActions: z
    .array(
      proposedActionSchema.extend({
        days: z.number().optional(),
        count: z.number().optional(),
        percent: z.number().optional(),
      }),
    )
    .default([]),
  findings: z
    .array(
      z.object({
        text: z.string().min(1).max(400),
        citesCatalogIds: z.array(z.string()),
        citesUsageIds: z.array(z.string()),
      }),
    )
    .max(2),
  subject: z.string().min(1).max(200).nullable(),
  body: z.string().min(1).max(4_000).nullable(),
});
export type AdoptionCoachOutput = z.infer<typeof adoptionCoachOutput>;

export const adoptionCoachInput = z.object({
  accountId: z.string().min(1),
  /** What asked: an adoption signal (its id) or a person. */
  reason: z.enum(["signal", "manual"]).default("signal"),
});
export type AdoptionCoachInput = z.infer<typeof adoptionCoachInput>;

const MAX_UNUSED = 6;
const MAX_USED = 4;

export async function adoptionCoachContext(
  db: ScopedDb,
  input: AdoptionCoachInput,
  ctx: TenantContext,
) {
  const empty = {
    bundle: [] as ContextBundle,
    vars: { csmName: "the CSM", contactName: "the customer", accountName: "the account" },
  };
  const account = await db.account.findUnique({
    where: { id: input.accountId },
    select: {
      id: true,
      name: true,
      plan: true,
      tier: true,
      archivedAt: true,
      owner: { include: { user: { select: { name: true } } } },
    },
  });
  if (!account || account.archivedAt) return empty;
  const adopt = await loadAdoption(ctx, account.id, businessClock);
  if (!adopt.features) return { ...empty, accountId: account.id };
  const never = new Set(adopt.features.neverUsed);
  const used = new Set(adopt.features.used);
  const [catalog, usage, latestDay, contact] = await Promise.all([
    db.featureCatalog.findMany({ where: { label: { in: [...never, ...used] } } }),
    db.featureUsageDaily.findMany({
      where: { accountId: account.id, users: { gt: 0 } },
      orderBy: { date: "desc" },
      take: 200,
    }),
    db.usageDaily.findFirst({ where: { accountId: account.id }, orderBy: { date: "desc" } }),
    firstEmailContact(db, account.id, null),
  ]);
  const unusedRows = catalog
    .filter((c) => never.has(c.label))
    .sort(
      (a, b) => Number(b.isKeyFeature) - Number(a.isKeyFeature) || a.label.localeCompare(b.label),
    )
    .slice(0, MAX_UNUSED);
  const usedRows = catalog.filter((c) => used.has(c.label));
  // The latest day each used feature was used: proof of what they do get value from.
  const latestUse = new Map<string, (typeof usage)[number]>();
  for (const u of usage) if (!latestUse.has(u.featureKey)) latestUse.set(u.featureKey, u);
  const usedUsage = usedRows
    .map((c) => ({ c, u: latestUse.get(c.featureKey) }))
    .filter((x): x is { c: (typeof usedRows)[number]; u: (typeof usage)[number] } => !!x.u)
    .slice(0, MAX_USED);

  const bundle: ContextBundle = [
    {
      sourceType: "Account",
      sourceId: account.id,
      fields: {
        name: account.name,
        plan: account.plan,
        featuresInPlan: adopt.features.bought,
        featuresNeverUsed: adopt.features.neverUsed.length,
        keyFeaturesNeverUsed: adopt.features.keyNeverUsed.length,
        summary: adopt.features.text,
      },
    },
    ...unusedRows.map((c) => ({
      sourceType: "FeatureCatalog",
      sourceId: c.id,
      fields: {
        feature: c.label,
        keyFeature: c.isKeyFeature,
        includedInPlan: account.plan,
        usedByThisAccount: false,
      },
    })),
    ...usedUsage.map(({ c, u }) => ({
      sourceType: "FeatureUsageDaily",
      sourceId: u.id,
      fields: { feature: c.label, lastUsed: formatCalendarDate(u.date), peopleThatDay: u.users },
    })),
    ...(latestDay
      ? [
          {
            sourceType: "UsageDaily",
            sourceId: latestDay.id,
            fields: {
              date: formatCalendarDate(latestDay.date),
              activeUsers: latestDay.activeUsers,
            },
          },
        ]
      : []),
    ...(contact
      ? [
          {
            sourceType: "Contact",
            sourceId: contact.id,
            fields: { name: contact.name, title: contact.title ?? null },
          },
        ]
      : []),
  ];
  return {
    bundle,
    accountId: account.id,
    vars: {
      csmName: account.owner?.user.name ?? "the CSM",
      contactName: contact?.name ?? "the customer",
      accountName: account.name,
    },
    facts: {
      count: adopt.features.neverUsed.length,
    } as Record<string, number>,
  };
}

export const adoptionCoach = defineAgent({
  key: "adoption-coach",
  version: "1.0.0",
  description:
    "Finds the value an account pays for and does not use, and drafts one nudge; every draft goes to Approvals",
  modelTier: "standard",
  tierReason:
    "A short finding and nudge from a few structured records: judgement, not depth (§6.1).",
  prompt: { name: "adoption-coach", version: "1.0.0" },
  inputSchema: adoptionCoachInput,
  outputSchema: adoptionCoachOutput,
  buildContext: adoptionCoachContext,
  extraCitations: (o) =>
    o.findings.flatMap((f) => [
      ...f.citesCatalogIds.map((id) => ({ sourceType: "FeatureCatalog", sourceId: id })),
      ...f.citesUsageIds.map((id) => ({ sourceType: "FeatureUsageDaily", sourceId: id })),
    ]),
  uncited: (o) =>
    o.findings
      .filter((f) => f.citesCatalogIds.length + f.citesUsageIds.length === 0)
      .map((f) => `the finding "${f.text.slice(0, 60)}" cites no feature record`),
  narrative: (o) => [...o.findings.map((f) => f.text), o.subject ?? "", o.body ?? ""],
  forbiddenNumericFields: NUMERIC,
  approvalPolicy: {
    HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
    MID_TOUCH: "DRAFT_FOR_APPROVAL",
    LONG_TAIL: "DRAFT_FOR_APPROVAL",
  },
  async act(output, ctx) {
    const contact = ctx.bundle.find((r) => r.sourceType === "Contact");
    if (!output.subject || !output.body || !contact || !ctx.accountId)
      return { effects: [], actionTaken: "NONE" };
    const approval = await requestApproval(ctx, {
      accountId: ctx.accountId,
      kind: "SEND_EMAIL",
      reason:
        `Adoption nudge: ${output.findings[0]?.text ?? "value the account has not used yet"}`.slice(
          0,
          500,
        ),
      proof: [
        ...output.citations.map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId })),
        ...output.findings.flatMap((f) => [
          ...f.citesCatalogIds.map((id) => ({ sourceType: "FeatureCatalog", sourceId: id })),
          ...f.citesUsageIds.map((id) => ({ sourceType: "FeatureUsageDaily", sourceId: id })),
        ]),
      ],
      proposedByAgentRunId: ctx.runId,
      triggeringText: [],
      sourceKey: ctx.sourceKey(0),
      email: {
        contactId: contact.sourceId,
        subject: output.subject,
        body: output.body,
        origin: "AI",
        agentRunId: ctx.runId,
      },
    });
    const message = await ctx.db.outboundMessage.findFirst({
      where: { approvalId: approval.id },
      select: { id: true },
    });
    return {
      effects: [
        { type: "Approval", id: approval.id },
        ...(message ? [{ type: "OutboundMessage", id: message.id }] : []),
      ],
      actionTaken: "APPROVAL_REQUESTED",
    };
  },
});
