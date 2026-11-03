import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { healthAnalyst } from "@/modules/agents/service";
import { exportAudit } from "@/modules/audit/service";
import { writeAudit } from "@/lib/audit";
import { ApprovalNotFoundError, approve, getApproval, reject } from "@/modules/approvals/service";
import { expectUpdateIsolated } from "./update-attack";

/**
 * Rule 2 for the M4 models (M4 rule 5). Kept in its own file: M4 may not edit pre-M4 test files.
 * Every model gets read, real-field update (with its own-row control), delete and raw-SQL attacks,
 * plus composite FKs that refuse references into another workspace.
 */
type Side = Awaited<ReturnType<typeof setup>>;
let A: Side;
let B: Side;

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const workspaceId = actor.workspaceId;
  const db = scopedDb(actor);
  const account = await db.account.create({
    data: { workspaceId, name: `${label} account`, tier: "MID_TOUCH" },
  });
  const contact = await db.contact.create({
    data: {
      workspaceId,
      accountId: account.id,
      name: `${label} contact`,
      email: `c@${label}.test`,
    },
  });
  const definition = await db.agentDefinition.create({
    data: { workspaceId, agentKey: "health-analyst", codeVersion: "1.0.0" },
  });
  const run = await db.agentRun.create({
    data: {
      workspaceId,
      agentKey: "health-analyst",
      agentVersion: "1.0.0",
      promptName: "health-analyst",
      promptVersion: "1.0.0",
      model: "model-from-env",
      modelTier: "standard",
      triggerType: "test",
      triggerId: label,
      idempotencyKey: `idem-${label}`,
      inputRefs: [{ sourceType: "Account", sourceId: account.id }],
      accountId: account.id,
      status: "SUCCEEDED",
      output: { items: [] },
      reasoningSummary: "r",
      confidence: 0.5,
    },
  });
  const approval = await db.approval.create({
    data: {
      workspaceId,
      accountId: account.id,
      kind: "SEND_EMAIL",
      proposedByAgentRunId: run.id,
      reason: "r",
      proof: [{ sourceType: "Account", sourceId: account.id }],
      requiredLevel: "DRAFT_FOR_APPROVAL",
    },
  });
  const outbound = await db.outboundMessage.create({
    data: {
      workspaceId,
      accountId: account.id,
      contactId: contact.id,
      toEmail: contact.email!,
      approvalId: approval.id,
      subject: "s",
      bodyText: "b",
      status: "AWAITING_APPROVAL",
    },
  });
  const revision = await db.draftRevision.create({
    data: {
      workspaceId,
      approvalId: approval.id,
      outboundMessageId: outbound.id,
      version: 1,
      subject: "s",
      bodyText: "b",
      editedById: actor.membershipId,
    },
  });
  const suppression = await db.emailSuppression.create({
    data: { workspaceId, email: `gone@${label.toLowerCase()}.test`, reason: "BOUNCED" },
  });
  const today = await db.todayItem.create({
    data: {
      workspaceId,
      membershipId: actor.membershipId,
      itemType: "APPROVAL",
      refId: approval.id,
      accountId: account.id,
      title: "t",
      rankScore: 1,
      rankReasons: [],
      computedAt: new Date(),
    },
  });
  const extraction = await db.extraction.create({
    data: {
      workspaceId,
      sourceType: "TICKET",
      sourceId: "t1",
      accountId: account.id,
      kind: "SENTIMENT",
      payload: { label: "NEGATIVE" },
      quote: "q",
      confidence: 0.9,
      promptVersion: "1.0.0",
      itemIndex: 0,
      agentRunId: run.id,
    },
  });
  return {
    actor,
    workspaceId,
    db,
    account,
    contact,
    definition,
    run,
    approval,
    outbound,
    revision,
    suppression,
    today,
    extraction,
  };
}

beforeAll(async () => {
  A = await setup("TenantM4A");
  B = await setup("TenantM4B");
});

const CASES = [
  { model: "AgentDefinition", delegate: "agentDefinition", row: (s: Side) => s.definition },
  { model: "AgentRun", delegate: "agentRun", row: (s: Side) => s.run },
  { model: "Approval", delegate: "approval", row: (s: Side) => s.approval },
  { model: "DraftRevision", delegate: "draftRevision", row: (s: Side) => s.revision },
  { model: "OutboundMessage", delegate: "outboundMessage", row: (s: Side) => s.outbound },
  { model: "EmailSuppression", delegate: "emailSuppression", row: (s: Side) => s.suppression },
  { model: "TodayItem", delegate: "todayItem", row: (s: Side) => s.today },
  { model: "Extraction", delegate: "extraction", row: (s: Side) => s.extraction },
] as const;

const fk = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";

describe("tenant isolation — M4 agent, approval and outbound models (Rule 2)", () => {
  for (const c of CASES) {
    it(`${c.model}: A cannot read, update or delete B's row`, async () => {
      // Delegates differ per model; only the shared id/workspaceId surface is used here.
      const d = A.db[c.delegate] as unknown as {
        findMany: () => Promise<Array<{ workspaceId: string }>>;
        findUnique: (a: { where: { id: string } }) => Promise<unknown>;
        deleteMany: (a: { where: { id: string } }) => Promise<{ count: number }>;
      };
      const bId = c.row(B).id;
      const rows = await d.findMany();
      expect(rows.length).toBeGreaterThan(0); // control: A sees its own rows
      expect(rows.every((r) => r.workspaceId === A.workspaceId)).toBe(true);
      expect(await d.findUnique({ where: { id: bId } })).toBeNull();
      await expectUpdateIsolated(c.delegate, d, bId, c.row(A).id);
      expect((await d.deleteMany({ where: { id: bId } })).count).toBe(0);
      expect(
        await (B.db[c.delegate] as unknown as typeof d).findUnique({ where: { id: bId } }),
      ).not.toBeNull(); // B's row is still there
    });

    it(`${c.model}: raw SQL without the workspace setting sees nothing`, async () => {
      const rows = await rawDb.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${c.model}"`,
      );
      expect(Number(rows[0]?.n)).toBe(0);
    });
  }

  it("an approval cannot point at another workspace's account, run or assignee (composite FK)", async () => {
    const base = {
      workspaceId: A.workspaceId,
      kind: "SEND_EMAIL" as const,
      reason: "r",
      requiredLevel: "DRAFT_FOR_APPROVAL" as const,
    };
    await expect(
      A.db.approval.create({ data: { ...base, accountId: B.account.id } }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.approval.create({
        data: {
          ...base,
          accountId: A.account.id,
          proposedByAgentRunId: B.run.id,
          proof: [{ sourceType: "Account", sourceId: A.account.id }],
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.approval.create({
        data: { ...base, accountId: A.account.id, assigneeId: B.actor.membershipId },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("an outbound message cannot be addressed to another workspace's contact (composite FK)", async () => {
    await expect(
      A.db.outboundMessage.create({
        data: {
          workspaceId: A.workspaceId,
          accountId: A.account.id,
          contactId: B.contact.id,
          toEmail: "x@x.test",
          subject: "s",
          bodyText: "b",
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("a draft version cannot attach to another workspace's approval (composite FK)", async () => {
    await expect(
      A.db.draftRevision.create({
        data: {
          workspaceId: A.workspaceId,
          approvalId: B.approval.id,
          outboundMessageId: A.outbound.id,
          version: 9,
          subject: "s",
          bodyText: "b",
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("an extraction or a task cannot cite another workspace's agent run (composite FK)", async () => {
    await expect(
      A.db.extraction.create({
        data: {
          workspaceId: A.workspaceId,
          sourceType: "TICKET",
          sourceId: "t2",
          accountId: A.account.id,
          kind: "SENTIMENT",
          payload: {},
          quote: "q",
          confidence: 0.5,
          promptVersion: "1.0.0",
          itemIndex: 0,
          agentRunId: B.run.id,
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.task.create({
        data: {
          workspaceId: A.workspaceId,
          title: "t",
          ownerMembershipId: A.actor.membershipId,
          origin: "AI",
          agentRunId: B.run.id,
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("a Today item cannot belong to another workspace's member (composite FK)", async () => {
    await expect(
      A.db.todayItem.create({
        data: {
          workspaceId: A.workspaceId,
          membershipId: B.actor.membershipId,
          itemType: "TASK",
          refId: "x",
          title: "t",
          rankScore: 1,
          rankReasons: [],
          computedAt: new Date(),
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("approving or rejecting B's approval from A is not found (404), and B's stays pending", async () => {
    const pending = await B.db.approval.create({
      data: {
        workspaceId: B.workspaceId,
        accountId: B.account.id,
        kind: "SEND_EMAIL",
        reason: "r",
        requiredLevel: "DRAFT_FOR_APPROVAL",
      },
    });
    await expect(getApproval(A.actor, pending.id)).rejects.toBeInstanceOf(ApprovalNotFoundError);
    await expect(approve(A.actor, { approvalId: pending.id })).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    );
    await expect(
      reject(A.actor, { approvalId: pending.id, note: "cross-tenant" }),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
    expect((await B.db.approval.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe(
      "PENDING",
    );
  });

  it("A's agent context builder cannot load B's records", async () => {
    const snap = await B.db.healthModel.create({
      data: {
        workspaceId: B.workspaceId,
        version: 1,
        status: "ACTIVE",
        proposedBy: "SYSTEM_DEFAULT",
        pillarWeights: {},
        componentConfig: {},
        thresholds: { healthyMin: 70, watchMin: 45 },
      },
    });
    const built = await healthAnalyst.buildContext(
      A.db,
      { accountId: B.account.id, snapshotId: snap.id },
      A.actor,
    );
    expect(built.bundle).toEqual([]);
    expect(built.accountId).toBeUndefined();
  });

  it("the audit export contains only A's rows", async () => {
    await writeAudit({
      workspaceId: A.workspaceId,
      actorType: "SYSTEM",
      action: "test.mark",
      summary: "A-only row",
    });
    await writeAudit({
      workspaceId: B.workspaceId,
      actorType: "SYSTEM",
      action: "test.mark",
      summary: "B-only row",
    });
    const out = await exportAudit(A.actor, { action: "test." }, "json");
    const rows = JSON.parse(out.body) as Array<{ summary: string }>;
    expect(rows.map((r) => r.summary)).toEqual(["A-only row"]);
    expect(out.body).not.toContain("B-only row");
  });
});
