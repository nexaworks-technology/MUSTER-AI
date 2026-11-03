import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";

/**
 * The database refuses what M4's rules forbid, whatever the code does (Rules 1, 3, 5; Q-31):
 * an incomplete SUCCEEDED run, an agent proposal without proof, a sensitive item above
 * DRAFT_FOR_APPROVAL or decided from Slack, an edited draft overwritten in place.
 */
let db: ScopedDb;
let ws: string;
let accountId: string;
let membershipId: string;
let contactId: string;

const check = /violates check constraint|check_violation|immutable/i;

beforeAll(async () => {
  const { actor } = await createTestAdmin("M4Constraints");
  ws = actor.workspaceId;
  membershipId = actor.membershipId;
  db = scopedDb(actor);
  accountId = (
    await db.account.create({ data: { workspaceId: ws, name: "C", tier: "HIGH_TOUCH" } })
  ).id;
  contactId = (
    await db.contact.create({ data: { workspaceId: ws, accountId, name: "K", email: "k@c.test" } })
  ).id;
});

const run = (over: Record<string, unknown>) =>
  db.agentRun.create({
    data: {
      workspaceId: ws,
      agentKey: "health-analyst",
      agentVersion: "1.0.0",
      promptName: "health-analyst",
      modelTier: "standard",
      triggerType: "test",
      triggerId: "t",
      idempotencyKey: `k-${Math.random()}`,
      ...over,
    },
  });

const approval = (over: Record<string, unknown>) =>
  db.approval.create({
    data: {
      workspaceId: ws,
      accountId,
      kind: "SEND_EMAIL",
      reason: "r",
      requiredLevel: "DRAFT_FOR_APPROVAL",
      ...over,
    },
  });

describe("M4 database guarantees", () => {
  it("refuses a SUCCEEDED run without its audit fields (Rule 5)", async () => {
    await expect(run({ status: "SUCCEEDED", output: {}, reasoningSummary: "r" })).rejects.toThrow(
      check,
    );
    await expect(
      run({
        status: "SUCCEEDED",
        output: {},
        reasoningSummary: "r",
        confidence: 0.4,
        promptVersion: "1.0.0",
        model: "m",
      }),
    ).resolves.toBeTruthy();
  });

  it("refuses a failed run without a reason code", async () => {
    await expect(run({ status: "FAILED" })).rejects.toThrow(check);
    await expect(run({ status: "FAILED", errorCode: "MODEL_DECLINED" })).resolves.toBeTruthy();
  });

  it("refuses an agent's proposal with no proof (Rule 1)", async () => {
    const r = await run({});
    await expect(approval({ proposedByAgentRunId: r.id })).rejects.toThrow(check);
    await expect(
      approval({
        proposedByAgentRunId: r.id,
        proof: [{ sourceType: "Account", sourceId: accountId }],
      }),
    ).resolves.toBeTruthy();
  });

  it("caps a sensitive approval at DRAFT_FOR_APPROVAL; no level can lift it (Rule 3)", async () => {
    await expect(
      approval({ isSensitive: true, requiredLevel: "SEND_AUTOMATICALLY" }),
    ).rejects.toThrow(check);
    await expect(
      approval({ isSensitive: true, requiredLevel: "DO_AUTOMATICALLY" }),
    ).rejects.toThrow(check);
    await expect(approval({ isSensitive: true })).resolves.toBeTruthy();
  });

  it("never records a sensitive decision made from Slack (Q-31)", async () => {
    const a = await approval({ isSensitive: true });
    await expect(
      db.approval.update({
        where: { id: a.id },
        data: {
          status: "APPROVED",
          decidedById: membershipId,
          decidedAt: new Date(),
          decidedVia: "SLACK",
        },
      }),
    ).rejects.toThrow(check);
    await expect(
      db.approval.update({
        where: { id: a.id },
        data: {
          status: "APPROVED",
          decidedById: membershipId,
          decidedAt: new Date(),
          decidedVia: "APP",
        },
      }),
    ).resolves.toBeTruthy();
  });

  it("a decision names who, when and where; an edited approval carries its diff", async () => {
    const a = await approval({});
    await expect(
      db.approval.update({ where: { id: a.id }, data: { status: "REJECTED" } }),
    ).rejects.toThrow(check);
    await expect(
      db.approval.update({
        where: { id: a.id },
        data: {
          status: "EDITED_APPROVED",
          decidedById: membershipId,
          decidedAt: new Date(),
          decidedVia: "APP",
        },
      }),
    ).rejects.toThrow(check);
  });

  it("keeps draft versions immutable: an edit must write a new version", async () => {
    const a = await approval({});
    const o = await db.outboundMessage.create({
      data: {
        workspaceId: ws,
        accountId,
        contactId,
        toEmail: "k@c.test",
        subject: "s",
        bodyText: "b",
      },
    });
    const r = await db.draftRevision.create({
      data: {
        workspaceId: ws,
        approvalId: a.id,
        outboundMessageId: o.id,
        version: 1,
        subject: "s",
        bodyText: "b",
      },
    });
    await expect(
      db.draftRevision.update({ where: { id: r.id }, data: { bodyText: "x" } }),
    ).rejects.toThrow(check);
    await expect(
      db.draftRevision.create({
        data: {
          workspaceId: ws,
          approvalId: a.id,
          outboundMessageId: o.id,
          version: 1,
          subject: "s",
          bodyText: "c",
        },
      }),
    ).rejects.toThrow(); // the version number is unique per approval
  });

  it("a SENT message records when and the provider id; a HELD one says why", async () => {
    const base = {
      workspaceId: ws,
      accountId,
      contactId,
      toEmail: "k@c.test",
      subject: "s",
      bodyText: "b",
    };
    await expect(db.outboundMessage.create({ data: { ...base, status: "SENT" } })).rejects.toThrow(
      check,
    );
    await expect(db.outboundMessage.create({ data: { ...base, status: "HELD" } })).rejects.toThrow(
      check,
    );
    await expect(db.outboundMessage.create({ data: { ...base, origin: "AI" } })).rejects.toThrow(
      check,
    );
  });

  it("stores suppressed addresses lower-case, so the unique is case-insensitive", async () => {
    await expect(
      db.emailSuppression.create({
        data: { workspaceId: ws, email: "Gone@C.test", reason: "BOUNCED" },
      }),
    ).rejects.toThrow(check);
  });
});
