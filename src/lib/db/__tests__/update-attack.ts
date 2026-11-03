import { expect } from "vitest";

/**
 * The cross-tenant UPDATE attack shared by the tenant suites. Prisma updates nothing when `data`
 * is empty, so an empty update returns count 0 on anyone's rows and proves nothing. Each model
 * here gets a real, harmless column to write, and every attack has a control: the same write on
 * the caller's own row must land (count 1), or, for rows the database freezes, be refused.
 */
type UpdateDelegate = {
  updateMany: (a: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => Promise<{ count: number }>;
};

const touched = () => ({ updatedAt: new Date() });

/** Delegate name → the write to try; `frozen` rows are immutable by trigger, so the control is a refusal. */
export const UPDATE_ATTACKS: Record<
  string,
  { data: () => Record<string, unknown>; frozen?: true }
> = {
  account: { data: touched },
  contact: { data: touched },
  stakeholderRole: { data: () => ({ setByMembershipId: null }) },
  contract: { data: touched },
  subscription: { data: touched },
  invoice: { data: touched },
  revenueEvent: { data: () => ({ sourceType: "attack-control" }) },
  usageDaily: { data: () => ({ events: 1 }) },
  userUsageDaily: { data: () => ({ events: 1 }) },
  featureUsageDaily: { data: () => ({ events: 1 }) },
  featureCatalog: { data: touched },
  conversation: { data: touched },
  message: { data: () => ({ subject: "attack-control" }) },
  ticket: { data: touched },
  callTranscript: { data: () => ({ language: "en" }) },
  task: { data: touched },
  noteTemplate: { data: touched },
  note: { data: touched },
  notification: { data: () => ({ readAt: new Date() }) },
  segment: { data: touched },
  externalRef: { data: touched },
  importJob: { data: touched },
  missingDataPrompt: { data: touched },
  dataQualityIssue: { data: touched },
  healthModel: { data: touched },
  healthScoreSnapshot: { data: () => ({ inputsHash: "attack-control" }), frozen: true },
  healthReason: { data: () => ({ message: "attack-control" }), frozen: true },
  csmPulse: { data: () => ({ comment: "attack-control" }) },
  usageBaseline: { data: () => ({ historyDays: 91 }) },
  signalRule: { data: touched },
  signal: { data: touched },
  outcomeRecord: { data: touched },
  agentDefinition: { data: touched },
  agentRun: { data: touched },
  approval: { data: touched },
  draftRevision: { data: () => ({ subject: "attack-control" }), frozen: true },
  outboundMessage: { data: touched },
  emailSuppression: { data: () => ({ note: "attack-control" }) },
  todayItem: { data: () => ({ rankScore: 0.5 }) },
  extraction: { data: () => ({ confidence: 0.5 }) },
};

/** A writes B's row (count 0, nothing changes), then A writes its own row (the control). */
export async function expectUpdateIsolated(
  delegateName: string,
  delegate: unknown,
  bId: string,
  ownId: string,
) {
  const attack = UPDATE_ATTACKS[delegateName];
  if (!attack) throw new Error(`No update attack defined for ${delegateName}`);
  const d = delegate as UpdateDelegate;
  expect((await d.updateMany({ where: { id: bId }, data: attack.data() })).count).toBe(0);
  if (attack.frozen)
    await expect(d.updateMany({ where: { id: ownId }, data: attack.data() })).rejects.toThrow(
      /immutable/,
    );
  else expect((await d.updateMany({ where: { id: ownId }, data: attack.data() })).count).toBe(1);
}
