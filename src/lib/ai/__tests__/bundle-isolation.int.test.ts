import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import {
  askerFor,
  listAgents,
  prepareRun,
  retrieveAskAiContext as retrieve,
} from "@/modules/agents/service";

/**
 * M12 A12 (Rule 8, Q-19): what an agent puts in the bundle it sends to the model comes only from the
 * running workspace. Two workspaces (A, B) each hold a full set of records. For every agent that can
 * be prepared from fixtures: (1) prepared in A with A's ids, every bundle record exists in A and not
 * in B; (2) prepared in A with B's ids (a forged or stale id), no B record reaches the bundle.
 * Agents that cannot be prepared generically are listed in NOT_COVERED with the reason.
 */

type World = Awaited<ReturnType<typeof world>>;

async function world(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const day = (d: string) => new Date(`${d}T00:00:00Z`);
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: `${label} Retail`,
      tier: "HIGH_TOUCH",
      ownerMembershipId: actor.membershipId,
    },
  });
  const a = account.id;
  const contact = await db.contact.create({
    data: {
      workspaceId: ws,
      accountId: a,
      name: `${label} Contact`,
      email: `${label.toLowerCase()}@customer.test`,
    },
  });
  const contract = await db.contract.create({
    data: {
      workspaceId: ws,
      accountId: a,
      startDate: day("2026-01-01"),
      endDate: day("2026-12-31"),
      status: "ACTIVE",
      seatsPurchased: 50,
    },
  });
  const renewal = await db.renewal.create({
    data: {
      workspaceId: ws,
      accountId: a,
      contractId: contract.id,
      renewalDate: day("2026-12-31"),
      confidence: 60,
      confidenceBand: "MEDIUM",
      confidenceAsOf: day("2026-11-01"),
    },
  });
  const signal = await db.signal.create({
    data: {
      workspaceId: ws,
      accountId: a,
      ruleKey: "test_rule",
      ruleVersion: 1,
      category: "USAGE",
      severity: "WARN",
      polarity: "RISK",
      title: "Usage dropped",
      explanation: "Active users fell.",
      evidence: [{ sourceType: "Account", sourceId: a }],
      values: {},
      params: {},
      dedupeKey: `d-${label}`,
      firstSeenAt: day("2026-11-01"),
      lastSeenAt: day("2026-11-02"),
    },
  });
  const expansion = await db.expansionOpportunity.create({
    data: { workspaceId: ws, accountId: a, signalIds: [signal.id] },
  });
  const conversation = await db.conversation.create({
    data: {
      workspaceId: ws,
      accountId: a,
      channel: "EMAIL",
      startedAt: day("2026-11-01"),
      lastMessageAt: day("2026-11-01"),
    },
  });
  const message = await db.message.create({
    data: {
      workspaceId: ws,
      conversationId: conversation.id,
      accountId: a,
      direction: "INBOUND",
      sentAt: day("2026-11-01"),
      bodyText: "The export has failed again.",
      fromContactId: contact.id,
    },
  });
  const inbox = await db.inboxItem.create({
    data: {
      workspaceId: ws,
      accountId: a,
      sourceType: "MESSAGE",
      sourceId: message.id,
      matchedBy: "CONTACT_EMAIL",
      receivedAt: day("2026-11-01"),
    },
  });
  const note = await db.note.create({
    data: { workspaceId: ws, accountId: a, body: "Spoke to the champion about renewal." },
  });
  const promise = await db.promise.create({
    data: {
      workspaceId: ws,
      accountId: a,
      party: "US",
      what: "CSV export fix",
      dueDate: day("2026-10-24"),
      status: "LATE",
      statusReason: "late",
      quote: "We will fix it by October 24.",
      sourceType: "NOTE",
      sourceId: note.id,
      dedupeKey: `p-${label}`,
      origin: "HUMAN",
    },
  });
  const plan = await db.onboardingPlan.create({
    data: {
      workspaceId: ws,
      accountId: a,
      startDate: day("2026-10-01"),
      targetValueDate: day("2026-12-01"),
    },
  });
  await db.onboardingStep.create({
    data: {
      workspaceId: ws,
      planId: plan.id,
      key: "kickoff",
      position: 1,
      title: "Kickoff",
      ownerSide: "US",
      dueDate: day("2026-10-05"),
    },
  });
  const meeting = await db.meeting.create({
    data: {
      workspaceId: ws,
      accountId: a,
      title: `${label} sync`,
      startsAt: day("2026-11-10"),
      endsAt: day("2026-11-10"),
    },
  });
  const report = await db.reportSnapshot.create({
    data: {
      workspaceId: ws,
      reportKey: "portfolio",
      periodStart: day("2026-10-01"),
      periodEnd: day("2026-10-31"),
      filtersHash: `h-${label}`,
      data: {
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        accountsInScope: 1,
        sections: [],
      },
      trigger: "MANUAL",
      generatedAt: day("2026-11-01"),
    },
  });
  const model = await db.healthModel.create({
    data: {
      workspaceId: ws,
      version: 1,
      status: "ACTIVE",
      proposedBy: "SYSTEM_DEFAULT",
      pillarWeights: {},
      componentConfig: {},
      thresholds: { healthyMin: 70, watchMin: 45 },
    },
  });
  const snapshotId = randomUUID();
  await db.$tenantTransaction(async (tx) => {
    await tx.healthScoreSnapshot.create({
      data: {
        id: snapshotId,
        workspaceId: ws,
        accountId: a,
        healthModelId: model.id,
        asOf: day("2026-11-02"),
        overall: 60,
        adoption: 50,
        riskLevel: "WATCH",
        riskLevelExcludingPulse: "WATCH",
        effectiveWeights: {},
        inputsHash: snapshotId,
      },
    });
    await tx.healthReason.create({
      data: {
        id: randomUUID(),
        workspaceId: ws,
        snapshotId,
        pillar: "ADOPTION",
        component: "users",
        kind: "EVIDENCE",
        direction: "DOWN",
        impact: -6.9,
        input: "i",
        message: "Active users fell.",
        sources: [{ sourceType: "Account", sourceId: a }],
      },
    });
    await tx.account.update({ where: { id: a }, data: { currentHealthSnapshotId: snapshotId } });
  });
  const snapshot = { id: snapshotId };
  return {
    actor,
    db,
    ws,
    account,
    contact,
    contract,
    renewal,
    signal,
    expansion,
    message,
    inbox,
    note,
    promise,
    plan,
    meeting,
    report,
    snapshot,
  };
}

/** Per agent: the input naming that world's records. */
const INPUTS: Record<string, (w: World) => unknown> = {
  "health-analyst": (w) => ({ accountId: w.account.id, snapshotId: w.snapshot.id }),
  "promise-keeper": (w) => ({ promiseId: w.promise.id }),
  watcher: (w) => ({ sourceType: "NOTE", sourceId: w.note.id }),
  "support-risk": (w) => ({ inboxItemId: w.inbox.id }),
  "renewal-manager": (w) => ({ renewalId: w.renewal.id }),
  "expansion-finder": (w) => ({ opportunityId: w.expansion.id }),
  "onboarding-manager": (w) => ({ planId: w.plan.id, reason: "step_due" }),
  "adoption-coach": (w) => ({ accountId: w.account.id }),
  "champion-guard": (w) => ({ accountId: w.account.id, candidateContactId: w.contact.id }),
  "digital-csm": (w) => ({ accountId: w.account.id, contactId: w.contact.id }),
  outreach: (w) => ({ contactId: w.contact.id, accountId: w.account.id }),
  "meeting-qbr": (w) => ({
    action: "PREPARE_BRIEF",
    accountId: w.account.id,
    meetingId: w.meeting.id,
  }),
  "leader-reporter": (w) => ({ snapshotIds: [w.report.id] }),
  "play-builder": () => ({ userPrompt: "Nudge accounts whose usage dropped" }),
};

/** Agents this test does not prepare, with the reason. */
const NOT_COVERED: Record<string, string> = {
  "ask-ai":
    "Needs an asker and tool steps, not an entity id; covered by the dedicated retrieve() test below.",
};

/** Bundle source types that are not tenant records (no table row to look up). */
const NON_RECORD_TYPES = new Set(["UserPrompt"]);

/**
 * Agents whose own bundle is empty with the minimal fixtures here (they need a feature-usage history
 * or a departed champion). Their forged-id path (B's ids under A) is still exercised; their own-bundle
 * check is NOT, and is reported as not covered.
 */
const EMPTY_OWN_BUNDLE = new Set(["adoption-coach", "champion-guard"]);

/** Bundle source type names that differ from the table delegate name. */
const DELEGATE_ALIAS: Record<string, string> = { Member: "membership" };

const lowerFirst = (s: string) => DELEGATE_ALIAS[s] ?? s.charAt(0).toLowerCase() + s.slice(1);

type Delegate = { findFirst(args: { where: { id: string } }): Promise<unknown> };
const delegate = (db: ScopedDb, type: string): Delegate | undefined =>
  (db as unknown as Record<string, Delegate | undefined>)[lowerFirst(type)];

async function existsIn(db: ScopedDb, type: string, id: string): Promise<boolean | "unmapped"> {
  const d = delegate(db, type);
  if (!d || typeof d.findFirst !== "function") return "unmapped";
  return (await d.findFirst({ where: { id } })) !== null;
}

describe("agent context bundles never cross the workspace boundary (Rule 8)", () => {
  it("every registered agent is either covered or explicitly listed as not covered", () => {
    for (const def of listAgents()) {
      expect(
        def.key in INPUTS || def.key in NOT_COVERED,
        `agent ${def.key} has no isolation fixture`,
      ).toBe(true);
    }
  });

  it("A's agents build bundles from A's records only", async () => {
    const [A, B] = [await world("IsoA"), await world("IsoB")];
    const unmapped = new Set<string>();
    const counts: Record<string, string> = {};
    for (const def of listAgents().filter((d) => d.key in INPUTS)) {
      const make = INPUTS[def.key]!;
      // (1) A's own ids: records exist in A, none in B.
      const own = await prepareRun(A.actor, def, make(A));
      if (!EMPTY_OWN_BUNDLE.has(def.key))
        expect(own.built.bundle.length, `${def.key}: bundle empty`).toBeGreaterThan(0);
      counts[def.key] = own.built.bundle.map((r) => r.sourceType).join("|");
      for (const r of own.built.bundle) {
        if (NON_RECORD_TYPES.has(r.sourceType)) continue;
        const inA = await existsIn(A.db, r.sourceType, r.sourceId);
        if (inA === "unmapped") {
          unmapped.add(`${def.key}:${r.sourceType}`);
          continue;
        }
        expect(inA, `${def.key}: ${r.sourceType} ${r.sourceId} must exist in A`).toBe(true);
        expect(
          await existsIn(B.db, r.sourceType, r.sourceId),
          `${def.key}: ${r.sourceType} leaked from B`,
        ).toBe(false);
      }
      // (2) B's ids used under A's context: nothing of B's reaches the bundle (or the build refuses).
      const foreign = await prepareRun(A.actor, def, make(B)).catch(() => null);
      if (foreign) {
        for (const r of foreign.built.bundle) {
          if (NON_RECORD_TYPES.has(r.sourceType)) continue;
          expect(
            (await existsIn(B.db, r.sourceType, r.sourceId)) === true,
            `${def.key}: foreign ${r.sourceType} in bundle`,
          ).toBe(false);
        }
        const text =
          JSON.stringify(foreign.built.bundle) + foreign.request.input + foreign.request.system;
        for (const secretName of [
          "IsoB Retail",
          "IsoB Contact",
          "isob@customer.test",
          "IsoB sync",
        ]) {
          expect(text, `${def.key}: B data in prompt`).not.toContain(secretName);
        }
      }
    }
    console.info("A bundle contents:", JSON.stringify(counts, null, 1));
    // Reported, not hidden: source types that have no tenant table of that name.
    console.info("bundle types without a table lookup:", [...unmapped].sort().join(", ") || "none");
  });

  it("Ask AI retrieval with tool steps naming B's ids returns no B record", async () => {
    const [A, B] = [await world("AskA"), await world("AskB")];
    const actor = await askerFor(A.db, A.ws, A.actor.membershipId);
    const steps = [
      { tool: "getAccount360Summary", input: { accountId: B.account.id } },
      { tool: "getContract", input: { accountId: B.account.id } },
      { tool: "getHealthWithReasons", input: { accountId: B.account.id } },
      { tool: "listTickets", input: { accountId: B.account.id } },
      { tool: "listSignals", input: { accountId: B.account.id } },
      { tool: "listPromises", input: { accountId: B.account.id } },
      { tool: "readDocument", input: { documentId: B.account.id } },
      { tool: "searchAccounts", input: { query: "AskB" } },
      { tool: "searchConversations", input: { accountId: B.account.id } },
      { tool: "listRenewals", input: { windowDays: 365 } },
      { tool: "listSignals", input: {} },
    ];
    const { bundle } = await retrieve(actor, steps);
    const bIds = new Set([B.account.id, B.contact.id, B.contract.id, B.renewal.id, B.signal.id]);
    for (const r of bundle)
      expect(bIds.has(r.sourceId), `${r.sourceType} ${r.sourceId} from B`).toBe(false);
    expect(JSON.stringify(bundle)).not.toContain("AskB");
    // Positive control: the same tools do return A's records, so the empty B result is not a broken tool.
    const control = await retrieve(actor, [
      { tool: "getAccount360Summary", input: { accountId: A.account.id } },
    ]);
    expect(control.bundle.some((r) => r.sourceId === A.account.id)).toBe(true);
  });
});
