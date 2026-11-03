import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { approve, requestApproval } from "@/modules/approvals/service";
import { createTestAdmin } from "@/test/fixtures";
import { evaluateSevenDayCheckpoints, markActed } from "../service";

/**
 * The outcome ledger's write side (M4 §2, §5; ARCHITECTURE §6.5; acceptance #13): a flag becomes
 * ACTED when its approval is approved or its message is sent; IGNORED when nothing happened by day
 * 7 (a late action still turns it ACTED); the 7-day checkpoint records REPLIED or RECOVERED with
 * evidence, or NO_CHANGE.
 */
const DAY = 86_400_000;
let db: ScopedDb;
let admin: Actor;
let ws: string;

beforeAll(async () => {
  ({ actor: admin } = await createTestAdmin("Outcomes"));
  db = scopedDb(admin);
  ws = admin.workspaceId;
});

async function flagged(flaggedAt: Date) {
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: `A ${randomUUID().slice(0, 4)}`,
      tier: "HIGH_TOUCH",
      timezone: "UTC",
    },
  });
  const signal = await db.signal.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      ruleKey: "usage_drop_vs_normal",
      ruleVersion: 1,
      category: "USAGE",
      severity: "CRITICAL",
      polarity: "RISK",
      title: "Usage drop vs normal",
      explanation: "e",
      evidence: [{ sourceType: "Account", sourceId: account.id }],
      values: {},
      params: {},
      dedupeKey: `d:${account.id}`,
      firstSeenAt: flaggedAt,
      lastSeenAt: flaggedAt,
    },
  });
  const outcome = await db.outcomeRecord.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      signalId: signal.id,
      flagType: "RISK",
      flaggedAt,
    },
  });
  return { account, signal, outcome };
}

describe("actionTaken", () => {
  it("approve → send on a signal's check-in marks the flag ACTED, with both refs", async () => {
    const now = new Date("2026-11-03T15:00:00Z");
    const { account, signal, outcome } = await flagged(new Date(+now - DAY));
    const contact = await db.contact.create({
      data: { workspaceId: ws, accountId: account.id, name: "K", email: "k@x.test" },
    });
    const a = await requestApproval(admin, {
      accountId: account.id,
      kind: "SEND_EMAIL",
      reason: "r",
      proof: [{ sourceType: "Signal", sourceId: signal.id }],
      signalId: signal.id,
      proposedByMembershipId: admin.membershipId,
      sourceKey: randomUUID(),
      email: { contactId: contact.id, subject: "s", body: "b", origin: "HUMAN" },
    });
    const clock = () => now;
    await approve(
      admin,
      { approvalId: a.id },
      { clock, dispatch: { clock, transport: { name: "log", send: async () => ({ id: "p1" }) } } },
    );
    const row = await db.outcomeRecord.findUniqueOrThrow({ where: { id: outcome.id } });
    expect(row).toMatchObject({ actionTaken: "ACTED", firstActionAt: now });
    expect((row.actionRefs as Array<{ type: string }>).map((r) => r.type)).toEqual([
      "Approval",
      "OutboundMessage",
    ]);
    expect(
      await db.auditLog.count({ where: { targetId: outcome.id, action: "outcome.acted" } }),
    ).toBe(1);
  });

  it("no action by day 7 → IGNORED; a later action still turns it ACTED", async () => {
    const flag = new Date("2026-10-20T12:00:00Z");
    const { signal, outcome } = await flagged(flag);
    const r = await evaluateSevenDayCheckpoints(admin, () => new Date("2026-10-28T12:00:00Z"));
    expect(r.evaluated).toBeGreaterThanOrEqual(1);
    expect(await db.outcomeRecord.findUniqueOrThrow({ where: { id: outcome.id } })).toMatchObject({
      actionTaken: "IGNORED",
      d7Outcome: expect.objectContaining({ status: "NO_CHANGE", actionTaken: "IGNORED" }),
    });
    await markActed(
      admin,
      { signalId: signal.id },
      { type: "Task", id: "t1" },
      () => new Date("2026-10-30T12:00:00Z"),
    );
    expect(
      (await db.outcomeRecord.findUniqueOrThrow({ where: { id: outcome.id } })).actionTaken,
    ).toBe("ACTED");
  });
});

describe("7-day checkpoint", () => {
  it("REPLIED: the account wrote in after the first action, with the message as evidence", async () => {
    const flag = new Date("2026-10-10T12:00:00Z");
    const { account, signal, outcome } = await flagged(flag);
    await markActed(
      admin,
      { signalId: signal.id },
      { type: "Approval", id: "a1" },
      () => new Date("2026-10-11T12:00:00Z"),
    );
    const conv = await db.conversation.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        channel: "EMAIL",
        subject: "Re",
        startedAt: flag,
        lastMessageAt: flag,
      },
    });
    const reply = await db.message.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        conversationId: conv.id,
        direction: "INBOUND",
        sentAt: new Date("2026-10-13T09:00:00Z"),
        subject: "Re",
        bodyText: "Thanks, let's talk.",
      },
    });
    await evaluateSevenDayCheckpoints(admin, () => new Date("2026-10-18T12:00:00Z"));
    expect(
      (await db.outcomeRecord.findUniqueOrThrow({ where: { id: outcome.id } })).d7Outcome,
    ).toMatchObject({
      status: "REPLIED",
      actionTaken: "ACTED",
      evidence: [{ sourceType: "Message", sourceId: reply.id }],
    });
  });

  it("RECOVERED: the band improved and held through day 7, with the snapshots as evidence; evaluated once", async () => {
    const flag = new Date("2026-10-01T00:00:00Z");
    const { account, outcome } = await flagged(flag);
    const model =
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
      }));
    const snap = async (asOf: string, riskLevel: "AT_RISK" | "WATCH" | "HEALTHY") => {
      const id = randomUUID();
      await db.$tenantTransaction(async (tx) => {
        const reasonId = randomUUID();
        await tx.healthScoreSnapshot.create({
          data: {
            id,
            workspaceId: ws,
            accountId: account.id,
            healthModelId: model.id,
            asOf: new Date(asOf),
            overall: riskLevel === "AT_RISK" ? 30 : 60,
            adoption: 50,
            riskLevel,
            riskLevelExcludingPulse: riskLevel,
            effectiveWeights: {},
            inputsHash: id,
            riskReasonId: riskLevel === "AT_RISK" ? reasonId : null,
          },
        });
        await tx.healthReason.create({
          data: {
            id: reasonId,
            workspaceId: ws,
            snapshotId: id,
            pillar: "ADOPTION",
            component: "c",
            kind: "EVIDENCE",
            direction: "DOWN",
            impact: -5,
            input: "i",
            message: "m",
            sources: [{ sourceType: "Account", sourceId: account.id }],
          },
        });
      });
      return id;
    };
    const s0 = await snap("2026-10-01", "AT_RISK");
    const s1 = await snap("2026-10-04", "WATCH");
    const s2 = await snap("2026-10-07", "WATCH");
    await evaluateSevenDayCheckpoints(admin, () => new Date("2026-10-09T00:00:00Z"));
    const row = await db.outcomeRecord.findUniqueOrThrow({ where: { id: outcome.id } });
    expect(row.d7Outcome).toMatchObject({
      status: "RECOVERED",
      actionTaken: "IGNORED",
      evidence: [s0, s1, s2].map((id) => ({ sourceType: "HealthScoreSnapshot", sourceId: id })),
    });
    const again = await evaluateSevenDayCheckpoints(admin, () => new Date("2026-10-10T00:00:00Z"));
    expect(again.evaluated).toBe(0);
  });
});
