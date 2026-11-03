import type { Prisma } from "@prisma/client";
import type { ScopedDb } from "@/lib/db/scoped";
import { dayKey } from "./dates";
import { ids, seedId } from "./ids";
import { ROSTER, type AccountSpec } from "./roster";

/**
 * Onboarding (docs/SEED_DATA.md §7, M6). Three templates; a plan for each of the 8 onboarding
 * accounts in its story state; and completed plans from the past on adopted accounts, so time to
 * value has real cohorts (seed-only history, recorded in SEED_DATA). Steps due before today are
 * done by the account owner (a person) unless the story leaves them open; steps with a product
 * condition are left to the nightly pass, which completes them from the seeded usage (D1).
 * Idempotent: every row has a seed id and is upserted.
 */
type Step = {
  key: string;
  title: string;
  ownerSide: "US" | "CUSTOMER";
  dueDay: number;
  completesWhen?: Prisma.InputJsonObject;
};

const MID_STEPS: Step[] = [
  { key: "kickoff", title: "Kickoff call", ownerSide: "US", dueDay: 3 },
  { key: "admin_guide", title: "Send admin guide", ownerSide: "US", dueDay: 7 },
  { key: "sso", title: "SSO setup", ownerSide: "CUSTOMER", dueDay: 21 },
  {
    key: "first_dashboard",
    title: "First dashboard built",
    ownerSide: "CUSTOMER",
    dueDay: 21,
    completesWhen: { metric: "featureUsed", featureKey: "dashboards", minDays: 1 },
  },
  {
    key: "connect_data",
    title: "Connect a data source",
    ownerSide: "CUSTOMER",
    dueDay: 28,
    completesWhen: { metric: "featureUsed", featureKey: "data_connectors", minDays: 1 },
  },
  { key: "training", title: "Team training", ownerSide: "US", dueDay: 35 },
  { key: "review", title: "30-day review", ownerSide: "US", dueDay: 45 },
];

export const TEMPLATES = [
  {
    key: "mid",
    name: "Mid-touch standard (60d)",
    forTier: "MID_TOUCH" as const,
    targetDays: 60,
    steps: MID_STEPS,
    // Reports in a routine: with the seeded usage, Juniper Vet meets this on day 37 (M6-LOG).
    valueDefinition: [
      { metric: "featureUsed", featureKey: "data_connectors", minDays: 3 },
      { metric: "featureUsed", featureKey: "scheduled_reports", minDays: 32 },
      { metric: "activeSeatShare", min: 0.4, days: 10 },
    ],
  },
  {
    key: "high",
    name: "High-touch guided (90d)",
    forTier: "HIGH_TOUCH" as const,
    targetDays: 90,
    steps: [
      ...MID_STEPS.slice(0, 2),
      {
        key: "exec_alignment",
        title: "Exec alignment meeting",
        ownerSide: "US",
        dueDay: 14,
      } as Step,
      ...MID_STEPS.slice(2),
    ],
    valueDefinition: [
      { metric: "keyFeaturesUsed", min: 4 },
      { metric: "activeSeatShare", min: 0.6, days: 10 },
    ],
  },
  {
    key: "long",
    name: "Long-tail self-serve (21d)",
    forTier: "LONG_TAIL" as const,
    targetDays: 21,
    steps: [
      { key: "welcome", title: "Welcome email", ownerSide: "US", dueDay: 0 },
      {
        key: "first_dashboard",
        title: "First dashboard built",
        ownerSide: "CUSTOMER",
        dueDay: 7,
        completesWhen: { metric: "featureUsed", featureKey: "dashboards", minDays: 1 },
      },
      { key: "invite_team", title: "Invite the team", ownerSide: "CUSTOMER", dueDay: 14 },
    ] as Step[],
    valueDefinition: [
      { metric: "keyFeaturesUsed", min: 2 },
      { metric: "activeUsers", min: 2, days: 5 },
    ],
  },
];

/** Story: which steps stay open (not done by a person), and extra facts. */
const STORIES: Record<
  string,
  { open: string[]; blocked?: Record<string, string>; customerOwner?: string; targetDays?: number }
> = {
  pinecrest: { open: ["sso", "first_dashboard", "connect_data"], customerOwner: "raj" },
  wrenfield: { open: ["first_dashboard"] },
  ostara: { open: ["first_dashboard", "connect_data"] },
  "cobalt-ridge": { open: ["first_dashboard"] },
  lumen: { open: [], targetDays: 60 },
  saltmarsh: { open: [] },
  ridgeback: {
    open: ["first_dashboard", "connect_data"],
    blocked: { security_review: "waiting on legal review" },
  },
};

/** Days to value of past plans, per cohort (median 52 for Growth 51-200; P75 70 for Scale). */
const HISTORY: Array<{ match: (a: AccountSpec) => boolean; ttv: number[] }> = [
  {
    match: (a) => a.tier === "MID_TOUCH" && a.plan === "Growth" && a.employeeBand === "51-200",
    ttv: [40, 45, 48, 50, 52, 55, 58, 62, 70],
  },
  {
    match: (a) => a.tier === "MID_TOUCH" && a.plan === "Growth" && a.employeeBand === "201-1000",
    ttv: [14, 16, 18, 20],
  },
  { match: (a) => a.tier === "HIGH_TOUCH" && a.plan === "Scale", ttv: [55, 60, 62, 70, 80] },
];
const HISTORY_START_DAYS_AGO = 300;

const json = (v: unknown) => v as Prisma.InputJsonValue;

/** Past value evidence: the seeded UsageDaily row of that day, with its real count. */
async function usageProof(db: ScopedDb, accountKey: string, daysAgo: number) {
  const id = seedId(`ud:${accountKey}:${daysAgo}`);
  const row = await db.usageDaily.findUniqueOrThrow({ where: { id } });
  return json([
    {
      sourceType: "UsageDaily",
      sourceId: id,
      value: row.activeUsers,
      date: row.date.toISOString().slice(0, 10),
    },
  ]);
}

export async function seedOnboarding(db: ScopedDb, workspaceId: string): Promise<void> {
  const templateId = (key: string) => seedId(`onboarding-template:${key}`);
  for (const t of TEMPLATES) {
    const data = {
      name: t.name,
      forTier: t.forTier,
      targetDays: t.targetDays,
      steps: json(t.steps),
      valueDefinition: json(t.valueDefinition),
      archivedAt: null,
    };
    await db.onboardingTemplate.upsert({
      where: { id: templateId(t.key) },
      create: { id: templateId(t.key), workspaceId, ...data },
      update: data,
    });
  }
  const templateFor = (a: AccountSpec) => TEMPLATES.find((t) => t.forTier === a.tier)!;

  // Open plans for the onboarding accounts. None is seeded as reached: the nightly pass finds
  // Juniper Vet's value day from its usage, with the proving rows (D1).
  for (const a of ROSTER.filter((x) => x.stage === "ONBOARDING" && x.onboardingDay !== undefined)) {
    const t = templateFor(a);
    const day = a.onboardingDay!;
    const story = STORIES[a.key] ?? { open: [] };
    const planId = seedId(`onboarding-plan:${a.key}`);
    const plan = {
      accountId: ids.account(a.key),
      templateId: templateId(t.key),
      startDate: dayKey(day),
      targetValueDate: dayKey(day - (story.targetDays ?? t.targetDays)),
      status: "ACTIVE" as const,
      valueReachedAt: null,
      valueEvidence: json([]),
      stallReason: null,
      blockers: json([]),
      handoff: json({}),
      lastEvaluatedOn: null,
    };
    await db.onboardingPlan.upsert({
      where: { id: planId },
      create: { id: planId, workspaceId, ...plan },
      update: plan,
    });
    const owner = a.owner ? ids.membership(a.owner) : null;
    const steps = [
      ...t.steps,
      ...(a.key === "ridgeback"
        ? [
            {
              key: "security_review",
              title: "Security review",
              ownerSide: "CUSTOMER" as const,
              dueDay: 30,
            },
          ]
        : []),
    ];
    for (const [i, s] of steps.entries()) {
      const id = seedId(`onboarding-step:${a.key}:${s.key}`);
      // A product-condition step is the nightly pass's to complete (D1).
      const humanDone = s.dueDay < day && !story.open.includes(s.key) && !s.completesWhen;
      const data = {
        planId,
        key: s.key,
        position: i + 1,
        title: s.title,
        ownerSide: s.ownerSide,
        ownerMembershipId: s.ownerSide === "US" ? owner : null,
        ownerContactId:
          s.ownerSide === "CUSTOMER" && story.customerOwner
            ? ids.contact(a.key, story.customerOwner)
            : null,
        dueDate: dayKey(day - s.dueDay),
        completesWhen: s.completesWhen ? json(s.completesWhen) : undefined,
        doneAt: humanDone ? dayKey(day - s.dueDay) : null,
        completedVia: humanDone ? ("HUMAN" as const) : null,
        completedByMembershipId: humanDone ? (owner ?? ids.membership("priya")) : null,
        evidence: json([]),
        blockedReason: story.blocked?.[s.key] ?? null,
      };
      await db.onboardingStep.upsert({
        where: { id },
        create: { id, workspaceId, ...data },
        update: data,
      });
    }
  }

  // Completed plans from the past on adopted accounts: cohort time to value (D3).
  for (const h of HISTORY) {
    const peers = ROSTER.filter(
      (a) =>
        ["ADOPTING", "MATURE", "RENEWING"].includes(a.stage) &&
        a.churnedDaysAgo === undefined &&
        h.match(a),
    );
    for (const [i, a] of peers.entries()) {
      const ttv = h.ttv[i % h.ttv.length]!;
      const reached = HISTORY_START_DAYS_AGO - ttv;
      const t = templateFor(a);
      const planId = seedId(`onboarding-plan:history:${a.key}`);
      const plan = {
        accountId: ids.account(a.key),
        templateId: templateId(t.key),
        startDate: dayKey(HISTORY_START_DAYS_AGO),
        targetValueDate: dayKey(HISTORY_START_DAYS_AGO - t.targetDays),
        status: "COMPLETE" as const,
        valueReachedAt: dayKey(reached),
        valueEvidence: await usageProof(db, a.key, reached),
        stallReason: null,
        blockers: json([]),
        handoff: json({}),
      };
      await db.onboardingPlan.upsert({
        where: { id: planId },
        create: { id: planId, workspaceId, ...plan },
        update: plan,
      });
    }
  }

  // Stated goals for the handoff (Saltmarsh's two from the CRM deal notes; Pinecrest's one).
  const goals: Array<{ key: string; account: string; text: string; quote: string }> = [
    {
      key: "saltmarsh-1",
      account: "saltmarsh",
      text: "Publish weekly audience reports without manual exports",
      quote: "From the deal notes: wants weekly audience reports without exports",
    },
    {
      key: "saltmarsh-2",
      account: "saltmarsh",
      text: "Give account managers one dashboard per client",
      quote: "From the deal notes: one dashboard per client for AMs",
    },
    {
      key: "pinecrest-1",
      account: "pinecrest",
      text: "Clinical ops reporting in one place by the end of the quarter",
      quote: "From the deal notes: clinical ops reporting in one place by quarter end",
    },
  ];
  for (const g of goals) {
    const id = seedId(`goal:${g.key}`);
    const data = {
      accountId: ids.account(g.account),
      text: g.text,
      sourceType: "Account",
      sourceId: ids.account(g.account),
      quote: g.quote,
      origin: "HUMAN" as const,
      status: "OPEN" as const,
    };
    await db.goal.upsert({ where: { id }, create: { id, workspaceId, ...data }, update: data });
  }
}
