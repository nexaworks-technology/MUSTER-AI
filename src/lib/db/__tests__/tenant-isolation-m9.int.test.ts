import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";

/**
 * Rule 2 for the M9 models (Promise, InboxItem, UnmatchedInbound) and the M9 changes to Extraction
 * and Goal. Strengthened attack pattern: a real-field update or delete on another workspace's row
 * changes 0 rows, the own-row control changes 1; composite FKs refuse references across tenants.
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
  const run = await db.agentRun.create({
    data: {
      workspaceId,
      agentKey: "watcher",
      agentVersion: "1.0.0",
      promptName: "watcher-extraction",
      promptVersion: "1.0.0",
      model: "model-from-env",
      modelTier: "fast",
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
  const extraction = await db.extraction.create({
    data: {
      workspaceId,
      sourceType: "MESSAGE",
      sourceId: "m1",
      accountId: account.id,
      kind: "PROMISE",
      payload: { what: "fix it", dueDate: null },
      quote: "We will fix it",
      confidence: 0.9,
      promptVersion: "1.1.0",
      itemIndex: 0,
      chunkIndex: 0,
      agentRunId: run.id,
    },
  });
  const goal = await db.goal.create({
    data: {
      workspaceId,
      accountId: account.id,
      text: "Cut close to 3 days",
      origin: "AI",
      agentRunId: run.id,
      extractionId: extraction.id,
      quote: "cut close to 3 days",
    },
  });
  const promise = await db.promise.create({
    data: {
      workspaceId,
      accountId: account.id,
      party: "US",
      what: "fix it",
      statusReason: "Not due yet.",
      sourceType: "MESSAGE",
      sourceId: "m1",
      quote: "We will fix it",
      extractionId: extraction.id,
      dedupeKey: `k-${label}`,
      origin: "AI",
      agentRunId: run.id,
    },
  });
  const inbox = await db.inboxItem.create({
    data: {
      workspaceId,
      accountId: account.id,
      sourceType: "MESSAGE",
      sourceId: "m1",
      matchedBy: "SOURCE",
      receivedAt: new Date("2026-11-01"),
    },
  });
  const unmatched = await db.unmatchedInbound.create({
    data: {
      workspaceId,
      provider: "GMAIL",
      externalId: `ext-${label}`,
      fromAddress: "who@shared.test",
      toAddresses: ["csm@us.test"],
      bodyText: "hello",
      receivedAt: new Date("2026-11-01"),
      reason: "2 accounts share shared.test",
      candidateAccountIds: [account.id],
    },
  });
  return { actor, workspaceId, db, account, run, extraction, goal, promise, inbox, unmatched };
}

beforeAll(async () => {
  A = await setup("TenantM9A");
  B = await setup("TenantM9B");
});

type Delegate = {
  findMany: () => Promise<Array<{ workspaceId: string }>>;
  findUnique: (a: { where: { id: string } }) => Promise<unknown>;
  updateMany: (a: {
    where: { id: string };
    data: Record<string, unknown>;
  }) => Promise<{ count: number }>;
  deleteMany: (a: { where: { id: string } }) => Promise<{ count: number }>;
};

const CASES = [
  {
    model: "Promise",
    delegate: "promise",
    row: (s: Side) => s.promise,
    write: () => ({ what: "attack-control" }),
  },
  {
    model: "InboxItem",
    delegate: "inboxItem",
    row: (s: Side) => s.inbox,
    write: () => ({ status: "CLOSED" }),
  },
  {
    model: "UnmatchedInbound",
    delegate: "unmatchedInbound",
    row: (s: Side) => s.unmatched,
    write: () => ({ reason: "attack-control" }),
  },
  {
    model: "Extraction",
    delegate: "extraction",
    row: (s: Side) => s.extraction,
    write: () => ({ flags: ["attack-control"] }),
  },
  {
    model: "Goal",
    delegate: "goal",
    row: (s: Side) => s.goal,
    write: () => ({ text: "attack-control" }),
  },
] as const;

const fk = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";
const check = (e: unknown) => e instanceof Error && /check constraint|violates/i.test(e.message);

describe("tenant isolation — M9 models (Rule 2)", () => {
  for (const c of CASES) {
    it(`${c.model}: A cannot read, update (real field) or delete B's row; A's own write lands`, async () => {
      const d = A.db[c.delegate] as unknown as Delegate;
      const bId = c.row(B).id;
      const rows = await d.findMany();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.workspaceId === A.workspaceId)).toBe(true);
      expect(await d.findUnique({ where: { id: bId } })).toBeNull();
      expect((await d.updateMany({ where: { id: bId }, data: c.write() })).count).toBe(0);
      expect((await d.updateMany({ where: { id: c.row(A).id }, data: c.write() })).count).toBe(1);
      expect((await d.deleteMany({ where: { id: bId } })).count).toBe(0);
      expect(
        await (B.db[c.delegate] as unknown as Delegate).findUnique({ where: { id: bId } }),
      ).not.toBeNull();
    });

    it(`${c.model}: raw SQL without the workspace setting sees nothing`, async () => {
      const rows = await rawDb.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM "${c.model}"`,
      );
      expect(Number(rows[0]?.n)).toBe(0);
    });
  }

  it("Promise cannot point to an account, extraction or owner in another workspace", async () => {
    const base = {
      workspaceId: A.workspaceId,
      party: "US" as const,
      what: "x",
      statusReason: "r",
    };
    await expect(
      A.db.promise.create({ data: { ...base, accountId: B.account.id, dedupeKey: "x1" } }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.promise.create({
        data: { ...base, accountId: A.account.id, dedupeKey: "x2", extractionId: B.extraction.id },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("InboxItem cannot point to an account in another workspace", async () => {
    await expect(
      A.db.inboxItem.create({
        data: {
          workspaceId: A.workspaceId,
          accountId: B.account.id,
          sourceType: "TICKET",
          sourceId: "t9",
          matchedBy: "MANUAL",
          receivedAt: new Date(),
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("UnmatchedInbound cannot be assigned to an account in another workspace", async () => {
    await expect(
      A.db.unmatchedInbound.update({
        where: { id: A.unmatched.id },
        data: { assignedAccountId: B.account.id },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("Goal cannot point to an extraction in another workspace", async () => {
    await expect(
      A.db.goal.create({
        data: {
          workspaceId: A.workspaceId,
          accountId: A.account.id,
          text: "x",
          origin: "AI",
          agentRunId: A.run.id,
          extractionId: B.extraction.id,
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("an AI promise without its quote, or a KEPT one without evidence, is refused by the database", async () => {
    const base = {
      workspaceId: A.workspaceId,
      accountId: A.account.id,
      party: "US" as const,
      what: "x",
      statusReason: "r",
    };
    await expect(
      A.db.promise.create({
        data: { ...base, dedupeKey: "ai-no-quote", origin: "AI", agentRunId: A.run.id },
      }),
    ).rejects.toSatisfy(check);
    await expect(
      A.db.promise.create({ data: { ...base, dedupeKey: "kept-no-evidence", status: "KEPT" } }),
    ).rejects.toSatisfy(check);
  });

  it("an assigned or dismissed holding row cannot keep the text (D2)", async () => {
    await expect(
      A.db.unmatchedInbound.update({
        where: { id: A.unmatched.id },
        data: { status: "DISMISSED" },
      }),
    ).rejects.toSatisfy(check);
  });

  it("a goal made from an extraction must be AI-origin and one goal per extraction", async () => {
    await expect(
      A.db.goal.create({
        data: {
          workspaceId: A.workspaceId,
          accountId: A.account.id,
          text: "dup",
          origin: "AI",
          agentRunId: A.run.id,
          extractionId: A.extraction.id,
        },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002",
    );
    await expect(
      A.db.goal.create({
        data: {
          workspaceId: A.workspaceId,
          accountId: A.account.id,
          text: "human",
          origin: "HUMAN",
          extractionId: A.extraction.id,
        },
      }),
    ).rejects.toBeDefined();
  });

  it("Extraction chunks do not collide: same item index in two chunks is allowed, twice in one is not", async () => {
    const data = (chunkIndex: number) => ({
      workspaceId: A.workspaceId,
      sourceType: "CALL_TRANSCRIPT" as const,
      sourceId: "c1",
      accountId: A.account.id,
      kind: "GOAL" as const,
      payload: { goal: "g" },
      quote: "g",
      confidence: 0.8,
      promptVersion: "1.1.0",
      itemIndex: 0,
      chunkIndex,
      agentRunId: A.run.id,
    });
    await A.db.extraction.create({ data: data(0) });
    await A.db.extraction.create({ data: data(1) });
    await expect(A.db.extraction.create({ data: data(1) })).rejects.toSatisfy(
      (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002",
    );
  });

  it("a title change is stamped by the database with the previous title", async () => {
    const c = await A.db.contact.create({
      data: { workspaceId: A.workspaceId, accountId: A.account.id, name: "T", title: "Ops Lead" },
    });
    expect(c.titleChangedAt).toBeNull();
    const u = await A.db.contact.update({ where: { id: c.id }, data: { title: "VP Ops" } });
    expect(u.previousTitle).toBe("Ops Lead");
    expect(u.titleChangedAt).not.toBeNull();
    const same = await A.db.contact.update({ where: { id: c.id }, data: { name: "T2" } });
    expect(same.titleChangedAt?.getTime()).toBe(u.titleChangedAt?.getTime());
  });
});
