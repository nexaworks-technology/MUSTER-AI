import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";

/**
 * Rule 2 for the M7 models (Renewal, RenewalOutcome, ExpansionOpportunity, Document). Its own
 * file, like M3–M6. The update attack writes a real, harmless column on B's row (count 0) and the
 * same write on A's own row as the control (count 1). RenewalOutcome is append-only: A's attack on
 * B's row still changes 0, and the control is the trigger refusing A's own update.
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
  const contract = await db.contract.create({
    data: {
      workspaceId,
      accountId: account.id,
      startDate: new Date("2025-12-01"),
      renewalDate: new Date("2026-12-01"),
      valueMinor: 3_600_000n,
    },
  });
  const renewal = await db.renewal.create({
    data: {
      workspaceId,
      accountId: account.id,
      contractId: contract.id,
      renewalDate: new Date("2026-12-01"),
      confidence: 55,
      confidenceBand: "MEDIUM",
      confidenceAsOf: new Date("2026-11-02"),
    },
  });
  const outcome = await db.renewalOutcome.create({
    data: {
      workspaceId,
      accountId: account.id,
      renewalId: renewal.id,
      result: "RENEWED",
      occurredOn: new Date("2026-12-01"),
      detectedVia: "CONTRACT_RECORDS",
      forecastConfidence: 55,
      forecastBand: "MEDIUM",
      forecastAsOf: new Date("2026-11-02"),
    },
  });
  const expansion = await db.expansionOpportunity.create({
    data: { workspaceId, accountId: account.id },
  });
  const document = await db.document.create({
    data: { workspaceId, accountId: account.id, kind: "RENEWAL_BRIEF", title: `${label} brief` },
  });
  return { actor, workspaceId, db, account, contract, renewal, outcome, expansion, document };
}

beforeAll(async () => {
  A = await setup("TenantM7A");
  B = await setup("TenantM7B");
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
    model: "Renewal",
    delegate: "renewal",
    row: (s: Side) => s.renewal,
    write: () => ({ forecastNote: "attack-control" }),
    appendOnly: false,
  },
  {
    model: "RenewalOutcome",
    delegate: "renewalOutcome",
    row: (s: Side) => s.outcome,
    write: () => ({ note: "attack-control" }),
    appendOnly: true,
  },
  {
    model: "ExpansionOpportunity",
    delegate: "expansionOpportunity",
    row: (s: Side) => s.expansion,
    write: () => ({ nextStep: "attack-control" }),
    appendOnly: false,
  },
  {
    model: "Document",
    delegate: "document",
    row: (s: Side) => s.document,
    write: () => ({ title: "attack-control" }),
    appendOnly: false,
  },
] as const;

const fk = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";

describe("tenant isolation — M7 models (Rule 2)", () => {
  for (const c of CASES) {
    it(`${c.model}: A cannot read, update (real field) or delete B's row${c.appendOnly ? "; A's own row is append-only" : "; A's own write lands"}`, async () => {
      const d = A.db[c.delegate] as unknown as Delegate;
      const bId = c.row(B).id;
      const rows = await d.findMany();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.workspaceId === A.workspaceId)).toBe(true);
      expect(await d.findUnique({ where: { id: bId } })).toBeNull();
      expect((await d.updateMany({ where: { id: bId }, data: c.write() })).count).toBe(0);
      if (c.appendOnly)
        await expect(d.updateMany({ where: { id: c.row(A).id }, data: c.write() })).rejects.toThrow(
          /immutable/,
        );
      else
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

  it("a renewal, outcome, opportunity or document cannot point into another workspace (composite FKs)", async () => {
    const ws = A.workspaceId;
    const renewalData = {
      workspaceId: ws,
      renewalDate: new Date("2027-01-01"),
      confidence: 50,
      confidenceBand: "MEDIUM" as const,
      confidenceAsOf: new Date("2026-11-02"),
    };
    await expect(
      A.db.renewal.create({
        data: { ...renewalData, accountId: B.account.id, contractId: A.contract.id },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.renewal.create({
        data: { ...renewalData, accountId: A.account.id, contractId: B.contract.id },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.renewalOutcome.create({
        data: {
          workspaceId: ws,
          accountId: A.account.id,
          renewalId: B.renewal.id,
          result: "CHURNED",
          occurredOn: new Date("2026-12-01"),
          detectedVia: "CONTRACT_RECORDS",
          forecastConfidence: 10,
          forecastBand: "LOW",
          forecastAsOf: new Date("2026-11-02"),
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.expansionOpportunity.create({ data: { workspaceId: ws, accountId: B.account.id } }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.expansionOpportunity.create({
        data: { workspaceId: ws, accountId: A.account.id, ownerMembershipId: B.actor.membershipId },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.document.create({
        data: { workspaceId: ws, accountId: B.account.id, kind: "QBR", title: "x" },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.renewal.update({
        where: { id: A.renewal.id },
        data: {
          forecastCategory: "COMMIT",
          forecastSetAt: new Date(),
          forecastSetByMembershipId: B.actor.membershipId,
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("the database refuses what the rules forbid", async () => {
    const ws = A.workspaceId;
    // A category with no author; a confidence out of range.
    await expect(
      A.db.renewal.update({ where: { id: A.renewal.id }, data: { forecastCategory: "COMMIT" } }),
    ).rejects.toThrow(/renewal_category_has_author/);
    await expect(
      A.db.renewal.update({ where: { id: A.renewal.id }, data: { confidence: 101 } }),
    ).rejects.toThrow(/renewal_confidence_range/);
    // A human outcome without a person; a second original outcome for the same renewal.
    await expect(
      A.db.renewalOutcome.create({
        data: {
          workspaceId: ws,
          accountId: A.account.id,
          renewalId: A.renewal.id,
          result: "CHURNED",
          occurredOn: new Date("2026-12-02"),
          detectedVia: "HUMAN",
          forecastConfidence: 10,
          forecastBand: "LOW",
          forecastAsOf: new Date("2026-11-02"),
          supersedesId: A.outcome.id,
        },
      }),
    ).rejects.toThrow(/outcome_human_has_author/);
    const second = {
      workspaceId: ws,
      accountId: A.account.id,
      renewalId: A.renewal.id,
      result: "CHURNED" as const,
      occurredOn: new Date("2026-12-02"),
      detectedVia: "CONTRACT_RECORDS" as const,
      forecastConfidence: 10,
      forecastBand: "LOW" as const,
      forecastAsOf: new Date("2026-11-02"),
    };
    await expect(A.db.renewalOutcome.create({ data: second })).rejects.toThrow();
    // A correction names the row it replaces and is allowed.
    const correction = await A.db.renewalOutcome.create({
      data: { ...second, supersedesId: A.outcome.id },
    });
    expect(correction.supersedesId).toBe(A.outcome.id);
    // An estimate with a number needs its method; an opportunity is always an estimate; an AI
    // document names its run.
    await expect(
      A.db.expansionOpportunity.create({
        data: { workspaceId: ws, accountId: A.account.id, estimateMinor: 1000n },
      }),
    ).rejects.toThrow(/expansion_estimate_has_method/);
    await expect(
      A.db.expansionOpportunity.create({
        data: { workspaceId: ws, accountId: A.account.id, isEstimate: false },
      }),
    ).rejects.toThrow(/expansion_is_estimate/);
    await expect(
      A.db.document.create({
        data: { workspaceId: ws, accountId: A.account.id, kind: "QBR", title: "x", origin: "AI" },
      }),
    ).rejects.toThrow(/document_agent_run_required/);
  });
});
