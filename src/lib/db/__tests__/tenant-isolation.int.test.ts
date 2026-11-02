import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, TenantViolationError } from "@/lib/db/scoped";
import { createTestWorkspace } from "@/test/fixtures";

/**
 * Rule 2: cross-tenant access must be impossible by construction. These tests try to break it
 * through every path available in M1. Every new [W] model is added here in its milestone.
 */
let A: Awaited<ReturnType<typeof setup>>;
let B: Awaited<ReturnType<typeof setup>>;

async function setup(label: string) {
  const { workspace, user } = await createTestWorkspace(label);
  const db = scopedDb({ workspaceId: workspace.id });
  const workspaceId = workspace.id;
  const membership = await db.membership.create({
    data: { workspaceId, userId: user.id, role: "ADMIN", canViewRevenue: true },
  });
  const invitation = await db.invitation.create({
    data: {
      workspaceId,
      email: `invitee-${label}@example.test`,
      role: "CSM",
      tokenHash: `hash-${label}-${workspace.id}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      invitedByMembershipId: membership.id,
    },
  });
  const settings = await db.workspaceSettings.create({
    data: { workspaceId, data: { note: label } },
  });
  const audit = await db.auditLog.create({
    data: { workspaceId, actorType: "SYSTEM", action: "test.seeded", summary: `seeded ${label}` },
  });
  return { workspace, user, db, membership, invitation, settings, audit };
}

beforeAll(async () => {
  A = await setup("TenantA");
  B = await setup("TenantB");
});

describe("tenant isolation (Rule 2)", () => {
  it("1. reads through A's client never return B's rows, for every [W] model", async () => {
    const delegates = [
      A.db.membership,
      A.db.invitation,
      A.db.workspaceSettings,
      A.db.auditLog,
    ] as const;
    for (const delegate of delegates) {
      // Each delegate has a different row type; only workspaceId is read here.
      const rows = (await (delegate as typeof A.db.membership).findMany()) as Array<{
        workspaceId: string;
      }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.workspaceId === A.workspace.id)).toBe(true);
    }
    expect(await A.db.membership.findFirst({ where: { id: B.membership.id } })).toBeNull();
    expect(await A.db.membership.findUnique({ where: { id: B.membership.id } })).toBeNull();
    expect(await A.db.invitation.count({ where: { id: B.invitation.id } })).toBe(0);
    expect(await A.db.auditLog.count({ where: { id: B.audit.id } })).toBe(0);
  });

  it("2. updates and deletes through A with B's ids change nothing", async () => {
    await expect(
      A.db.membership.update({ where: { id: B.membership.id }, data: { role: "VIEWER" } }),
    ).rejects.toMatchObject({ code: "P2025" });
    const many = await A.db.membership.updateMany({
      where: { id: B.membership.id },
      data: { role: "VIEWER" },
    });
    expect(many.count).toBe(0);
    await expect(A.db.invitation.delete({ where: { id: B.invitation.id } })).rejects.toMatchObject({
      code: "P2025",
    });
    expect((await A.db.invitation.deleteMany({ where: { id: B.invitation.id } })).count).toBe(0);

    const stillThere = await B.db.membership.findUnique({ where: { id: B.membership.id } });
    expect(stillThere?.role).toBe("ADMIN");
  });

  it("3. passing B's workspaceId to A's client throws", async () => {
    await expect(
      A.db.membership.findMany({ where: { workspaceId: B.workspace.id } }),
    ).rejects.toBeInstanceOf(TenantViolationError);
    await expect(
      A.db.auditLog.create({
        data: { workspaceId: B.workspace.id, actorType: "SYSTEM", action: "x", summary: "x" },
      }),
    ).rejects.toBeInstanceOf(TenantViolationError);
    await expect(
      A.db.membership.update({
        where: { id: A.membership.id },
        data: { workspaceId: B.workspace.id },
      }),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("4. raw SQL as app_user without app.workspace_id sees no tenant rows (RLS)", async () => {
    const rows = await rawDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Membership"`;
    expect(Number(rows[0]?.n)).toBe(0);
    const audit = await rawDb.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "AuditLog"`;
    expect(Number(audit[0]?.n)).toBe(0);
  });

  it("4b. RLS WITH CHECK blocks writing another workspace's rows even inside A's setting", async () => {
    await expect(
      rawDb.$transaction([
        rawDb.$executeRaw`SELECT set_config('app.workspace_id', ${A.workspace.id}, true)`,
        rawDb.$executeRaw`INSERT INTO "AuditLog" (id, "workspaceId", "actorType", action, summary)
          VALUES (${`x-${B.workspace.id}`}, ${B.workspace.id}, 'SYSTEM', 'x', 'x')`,
      ]),
    ).rejects.toThrow(/row-level security/);
  });

  it("5. a composite-FK insert referencing B's parent from A fails", async () => {
    await expect(
      A.db.invitation.create({
        data: {
          workspaceId: A.workspace.id,
          email: "cross@example.test",
          role: "CSM",
          tokenHash: `cross-${A.workspace.id}`,
          expiresAt: new Date(Date.now() + 86_400_000),
          invitedByMembershipId: B.membership.id,
        },
      }),
    ).rejects.toSatisfy(
      (e) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003",
    );
  });

  it("6. $queryRawUnsafe and $executeRawUnsafe are refused on the scoped client", async () => {
    await expect(A.db.$queryRawUnsafe("SELECT 1")).rejects.toBeInstanceOf(TenantViolationError);
    await expect(A.db.$executeRawUnsafe("SELECT 1")).rejects.toBeInstanceOf(TenantViolationError);
  });

  it("creates through A accept A's own workspaceId", async () => {
    const row = await A.db.auditLog.create({
      data: { workspaceId: A.workspace.id, actorType: "SYSTEM", action: "t", summary: "own" },
    });
    expect(row.workspaceId).toBe(A.workspace.id);
  });

  it("tagged raw SQL on the scoped client runs inside the workspace setting", async () => {
    const rows = await A.db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Membership"`;
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("interactive tenant transactions stay scoped", async () => {
    const count = await A.db.$tenantTransaction(async (tx) => {
      await tx.auditLog.create({
        data: { workspaceId: A.workspace.id, actorType: "SYSTEM", action: "tx", summary: "in tx" },
      });
      return tx.membership.count();
    });
    expect(count).toBe(1);
    await expect(
      A.db.$tenantTransaction((tx) =>
        tx.membership.findMany({ where: { workspaceId: B.workspace.id } }),
      ),
    ).rejects.toBeInstanceOf(TenantViolationError);
  });
});

// ─── M2 models ───────────────────────────────────────────────────────────────
// Every [W] model added from M2 on gets: a row in each workspace, then the same read/write/raw
// attacks as above. `M2_CASES` grows slice by slice; the model registry test guarantees no
// [W] model is forgotten in the schema-level checks.

type Side = Awaited<ReturnType<typeof setupM2>>;

async function setupM2(base: typeof A) {
  const workspaceId = base.workspace.id;
  const db = base.db;
  const account = await db.account.create({
    data: {
      workspaceId,
      name: `Acme ${workspaceId}`,
      tier: "MID_TOUCH",
      ownerMembershipId: base.membership.id,
    },
  });
  const contact = await db.contact.create({
    data: {
      workspaceId,
      accountId: account.id,
      name: "Pat Example",
      email: `pat-${workspaceId}@example.test`,
    },
  });
  const role = await db.stakeholderRole.create({
    data: {
      workspaceId,
      accountId: account.id,
      contactId: contact.id,
      role: "CHAMPION",
      validFrom: new Date(),
    },
  });
  const contract = await db.contract.create({
    data: {
      workspaceId,
      accountId: account.id,
      startDate: new Date("2026-01-01"),
      valueMinor: 100n,
    },
  });
  const subscription = await db.subscription.create({
    data: {
      workspaceId,
      accountId: account.id,
      contractId: contract.id,
      plan: "Growth",
      interval: "YEAR",
      amountMinor: 100n,
    },
  });
  const invoice = await db.invoice.create({
    data: {
      workspaceId,
      accountId: account.id,
      subscriptionId: subscription.id,
      number: "INV-T",
      amountMinor: 100n,
      issuedAt: new Date(),
      dueAt: new Date(),
    },
  });
  const revenueEvent = await db.revenueEvent.create({
    data: {
      workspaceId,
      accountId: account.id,
      type: "NEW",
      deltaArrMinor: 100n,
      currency: "USD",
      effectiveDate: new Date(),
      sourceType: "Contract",
      sourceId: contract.id,
    },
  });
  const day = new Date("2026-10-01");
  const usageDaily = await db.usageDaily.create({
    data: {
      workspaceId,
      accountId: account.id,
      date: day,
      activeUsers: 3,
      sessions: 4,
      events: 50,
    },
  });
  const userUsage = await db.userUsageDaily.create({
    data: {
      workspaceId,
      accountId: account.id,
      contactId: contact.id,
      externalUserId: "u1",
      date: day,
      events: 5,
      sessions: 1,
    },
  });
  const featureUsage = await db.featureUsageDaily.create({
    data: {
      workspaceId,
      accountId: account.id,
      featureKey: "dashboards",
      date: day,
      users: 2,
      events: 9,
    },
  });
  const feature = await db.featureCatalog.create({
    data: {
      workspaceId,
      featureKey: "dashboards",
      label: "Dashboards",
      includedInPlans: ["Growth"],
    },
  });
  const conversation = await db.conversation.create({
    data: {
      workspaceId,
      accountId: account.id,
      channel: "EMAIL",
      subject: "Hi",
      startedAt: day,
      lastMessageAt: day,
    },
  });
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId: conversation.id,
      accountId: account.id,
      direction: "INBOUND",
      fromContactId: contact.id,
      sentAt: day,
      bodyText: "Hello",
    },
  });
  const ticket = await db.ticket.create({
    data: {
      workspaceId,
      accountId: account.id,
      contactId: contact.id,
      conversationId: conversation.id,
      subject: "Help",
      openedAt: day,
    },
  });
  const transcript = await db.callTranscript.create({
    data: {
      workspaceId,
      conversationId: conversation.id,
      accountId: account.id,
      title: "Call",
      provider: "upload",
      occurredAt: day,
      text: "Transcript",
    },
  });
  const task = await db.task.create({
    data: {
      workspaceId,
      accountId: account.id,
      title: "Call them",
      ownerMembershipId: base.membership.id,
    },
  });
  const template = await db.noteTemplate.create({
    data: { workspaceId, name: `Check-in ${workspaceId}`, callType: "check-in", body: "Agenda" },
  });
  const note = await db.note.create({
    data: {
      workspaceId,
      accountId: account.id,
      authorMembershipId: base.membership.id,
      templateId: template.id,
      body: "Note",
    },
  });
  const notification = await db.notification.create({
    data: {
      workspaceId,
      recipientMembershipId: base.membership.id,
      type: "MENTION",
      title: "Hi",
      refType: "Note",
      refId: note.id,
    },
  });
  return {
    account,
    contact,
    role,
    contract,
    subscription,
    invoice,
    revenueEvent,
    usageDaily,
    userUsage,
    featureUsage,
    feature,
    conversation,
    message,
    ticket,
    transcript,
    task,
    template,
    note,
    notification,
    segment: await db.segment.create({
      data: {
        workspaceId,
        name: `Seg ${workspaceId}`,
        filter: { all: [{ field: "tier", op: "eq", value: "MID_TOUCH" }] },
        createdByMembershipId: base.membership.id,
      },
    }),
  };
}

const M2_CASES = [
  { model: "Account", delegate: "account", row: (s: Side) => s.account },
  { model: "Contact", delegate: "contact", row: (s: Side) => s.contact },
  { model: "StakeholderRole", delegate: "stakeholderRole", row: (s: Side) => s.role },
  { model: "Contract", delegate: "contract", row: (s: Side) => s.contract },
  { model: "Subscription", delegate: "subscription", row: (s: Side) => s.subscription },
  { model: "Invoice", delegate: "invoice", row: (s: Side) => s.invoice },
  { model: "RevenueEvent", delegate: "revenueEvent", row: (s: Side) => s.revenueEvent },
  { model: "UsageDaily", delegate: "usageDaily", row: (s: Side) => s.usageDaily },
  { model: "UserUsageDaily", delegate: "userUsageDaily", row: (s: Side) => s.userUsage },
  { model: "FeatureUsageDaily", delegate: "featureUsageDaily", row: (s: Side) => s.featureUsage },
  { model: "FeatureCatalog", delegate: "featureCatalog", row: (s: Side) => s.feature },
  { model: "Conversation", delegate: "conversation", row: (s: Side) => s.conversation },
  { model: "Message", delegate: "message", row: (s: Side) => s.message },
  { model: "Ticket", delegate: "ticket", row: (s: Side) => s.ticket },
  { model: "CallTranscript", delegate: "callTranscript", row: (s: Side) => s.transcript },
  { model: "Task", delegate: "task", row: (s: Side) => s.task },
  { model: "NoteTemplate", delegate: "noteTemplate", row: (s: Side) => s.template },
  { model: "Note", delegate: "note", row: (s: Side) => s.note },
  { model: "Notification", delegate: "notification", row: (s: Side) => s.notification },
  { model: "Segment", delegate: "segment", row: (s: Side) => s.segment },
] as const;

describe("tenant isolation — M2 models (Rule 2)", () => {
  let a2: Side;
  let b2: Side;
  beforeAll(async () => {
    a2 = await setupM2(A);
    b2 = await setupM2(B);
  });

  for (const c of M2_CASES) {
    it(`${c.model}: A cannot read, update or delete B's row`, async () => {
      // Delegates differ per model; only the shared id/workspaceId surface is used here.
      const d = A.db[c.delegate] as unknown as {
        findMany: () => Promise<Array<{ workspaceId: string }>>;
        findUnique: (a: { where: { id: string } }) => Promise<unknown>;
        updateMany: (a: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => Promise<{ count: number }>;
        deleteMany: (a: { where: { id: string } }) => Promise<{ count: number }>;
      };
      const bId = c.row(b2).id;
      expect((await d.findMany()).every((r) => r.workspaceId === A.workspace.id)).toBe(true);
      expect(await d.findUnique({ where: { id: bId } })).toBeNull();
      expect((await d.updateMany({ where: { id: bId }, data: {} })).count).toBe(0);
      expect((await d.deleteMany({ where: { id: bId } })).count).toBe(0);
    });

    it(`${c.model}: raw SQL without the workspace setting sees nothing`, async () => {
      const rows = await rawDb.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${c.model}"`,
      );
      expect(Number(rows[0]?.n)).toBe(0);
    });
  }

  it("a Contact cannot point at another workspace's Account (composite FK)", async () => {
    await expect(
      A.db.contact.create({
        data: { workspaceId: A.workspace.id, accountId: b2.account.id, name: "Cross" },
      }),
    ).rejects.toSatisfy(
      (e) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003",
    );
  });

  it("an Account cannot be owned by another workspace's member (composite FK)", async () => {
    await expect(
      A.db.account.create({
        data: {
          workspaceId: A.workspace.id,
          name: "Cross-owned",
          tier: "LONG_TAIL",
          ownerMembershipId: B.membership.id,
        },
      }),
    ).rejects.toSatisfy(
      (e) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003",
    );
  });

  it("billing and usage rows cannot point at another workspace's account or contract", async () => {
    const fk = (e: unknown) =>
      e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";
    await expect(
      A.db.contract.create({
        data: { workspaceId: A.workspace.id, accountId: b2.account.id, startDate: new Date() },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.subscription.create({
        data: {
          workspaceId: A.workspace.id,
          accountId: a2.account.id,
          contractId: b2.contract.id,
          plan: "x",
          interval: "YEAR",
          amountMinor: 1n,
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.usageDaily.create({
        data: {
          workspaceId: A.workspace.id,
          accountId: b2.account.id,
          date: new Date("2026-09-01"),
          activeUsers: 1,
          sessions: 1,
          events: 1,
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.userUsageDaily.create({
        data: {
          workspaceId: A.workspace.id,
          accountId: a2.account.id,
          contactId: b2.contact.id,
          externalUserId: "x",
          date: new Date("2026-09-01"),
          events: 1,
          sessions: 1,
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("messages, tickets and transcripts cannot reference another workspace's records", async () => {
    const fk = (e: unknown) =>
      e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";
    const ws = A.workspace.id;
    await expect(
      A.db.message.create({
        data: {
          workspaceId: ws,
          conversationId: b2.conversation.id,
          accountId: a2.account.id,
          direction: "INBOUND",
          sentAt: new Date(),
          bodyText: "x",
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.message.create({
        data: {
          workspaceId: ws,
          conversationId: a2.conversation.id,
          accountId: a2.account.id,
          fromContactId: b2.contact.id,
          direction: "INBOUND",
          sentAt: new Date(),
          bodyText: "x",
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.ticket.create({
        data: {
          workspaceId: ws,
          accountId: a2.account.id,
          conversationId: b2.conversation.id,
          subject: "x",
          openedAt: new Date(),
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.callTranscript.create({
        data: {
          workspaceId: ws,
          conversationId: b2.conversation.id,
          accountId: a2.account.id,
          title: "x",
          provider: "x",
          occurredAt: new Date(),
          text: "x",
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("tasks, notes and notifications cannot be assigned across workspaces", async () => {
    const fk = (e: unknown) =>
      e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";
    const ws = A.workspace.id;
    await expect(
      A.db.task.create({
        data: { workspaceId: ws, title: "x", ownerMembershipId: B.membership.id },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.task.create({
        data: {
          workspaceId: ws,
          accountId: b2.account.id,
          title: "x",
          ownerMembershipId: A.membership.id,
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.note.create({
        data: { workspaceId: ws, accountId: a2.account.id, templateId: b2.template.id, body: "x" },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.notification.create({
        data: {
          workspaceId: ws,
          recipientMembershipId: B.membership.id,
          type: "MENTION",
          title: "x",
          refType: "Note",
          refId: "x",
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("a sentiment label without the AgentRun that produced it is rejected (Rule 5)", async () => {
    await expect(
      A.db.message.update({ where: { id: a2.message.id }, data: { sentimentLabel: "NEGATIVE" } }),
    ).rejects.toThrow(/sentiment_agent_run_required|check constraint/i);
  });

  it("a StakeholderRole cannot join A's account to B's contact (composite FK)", async () => {
    await expect(
      A.db.stakeholderRole.create({
        data: {
          workspaceId: A.workspace.id,
          accountId: a2.account.id,
          contactId: b2.contact.id,
          role: "CHAMPION",
          validFrom: new Date(),
        },
      }),
    ).rejects.toSatisfy(
      (e) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003",
    );
  });

  it("an AI-origin StakeholderRole without an agent run is rejected by the database (Rule 5)", async () => {
    await expect(
      A.db.stakeholderRole.create({
        data: {
          workspaceId: A.workspace.id,
          accountId: a2.account.id,
          contactId: a2.contact.id,
          role: "CHAMPION",
          validFrom: new Date(),
          origin: "AI",
        },
      }),
    ).rejects.toThrow(/agent_run_required|check constraint/i);
  });
});
