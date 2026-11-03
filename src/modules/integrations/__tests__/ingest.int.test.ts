import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { countQueries } from "@/test/query-counter";
import { createTestAdmin } from "@/test/fixtures";
import { runDataQualityScan } from "@/modules/accounts/service";
import { ingestBatch, type IngestTarget } from "../ingest.service";

/**
 * M5 §5 ingest tests: idempotent re-sync, in-place updates, unknown owners left unassigned and
 * listed, per-record rejection, Q-32 / D1 conflicts, billing matching (D-84), tenant separation
 * with shared external ids (M5 rule 8) and the 500-record query budget (acceptance #14).
 */
type Ws = Awaited<ReturnType<typeof workspace>>;

async function workspace(label: string) {
  const { actor, user } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const hubspot = await db.integration.create({
    data: {
      workspaceId: actor.workspaceId,
      provider: "HUBSPOT",
      connectedAt: new Date("2026-10-01T00:00:00Z"),
    },
  });
  const salesforce = await db.integration.create({
    data: {
      workspaceId: actor.workspaceId,
      provider: "SALESFORCE",
      connectedAt: new Date("2026-10-20T00:00:00Z"),
    },
  });
  const stripe = await db.integration.create({
    data: { workspaceId: actor.workspaceId, provider: "STRIPE" },
  });
  const t = (i: { id: string }, source: IngestTarget["source"]): IngestTarget => ({
    workspaceId: actor.workspaceId,
    integrationId: i.id,
    source,
  });
  return {
    actor,
    adminEmail: user.email,
    db,
    hs: t(hubspot, "HUBSPOT"),
    sf: t(salesforce, "SALESFORCE"),
    st: t(stripe, "STRIPE"),
  };
}

const companies = (n: number, prefix = "co") =>
  Array.from({ length: n }, (_, i) => ({
    externalId: `${prefix}-${i}`,
    name: `Company ${i}`,
    domain: `${prefix}${i}.example`,
  }));

let A: Ws;
let B: Ws;
beforeAll(async () => {
  A = await workspace("IngestA");
  B = await workspace("IngestB");
});

describe("ingest: idempotent and mapped (M5 rule 2)", () => {
  it("the same batch twice creates nothing the second time", async () => {
    const W = await workspace("IngestTwice");
    const batch = { kind: "accounts" as const, records: companies(3, "twice") };
    const first = await ingestBatch(W.hs, batch);
    expect(first.counts).toMatchObject({ created: 3, updated: 0, unchanged: 0 });
    const second = await ingestBatch(W.hs, batch);
    expect(second.counts).toMatchObject({ created: 0, updated: 0, unchanged: 3, conflicts: 0 });
    expect(await W.db.account.count()).toBe(3);
    expect(await W.db.externalRef.count({ where: { source: "HUBSPOT" } })).toBe(3);
    const contacts = {
      kind: "contacts" as const,
      records: [
        {
          externalId: "p-1",
          accountExternalId: "twice-0",
          name: "Ana",
          email: "ana@twice0.example",
        },
      ],
    };
    expect((await ingestBatch(W.hs, contacts)).counts.created).toBe(1);
    expect((await ingestBatch(W.hs, contacts)).counts).toMatchObject({ created: 0, unchanged: 1 });
    expect(await W.db.contact.count()).toBe(1);
  });

  it("an updated external record updates the same row in place", async () => {
    const W = await workspace("IngestUpdate");
    await ingestBatch(W.hs, {
      kind: "accounts",
      records: [{ externalId: "u1", name: "Old Name" }],
    });
    const r = await ingestBatch(W.hs, {
      kind: "accounts",
      records: [{ externalId: "u1", name: "New Name", industry: "Fitness" }],
    });
    expect(r.counts).toMatchObject({ updated: 1, created: 0, conflicts: 0 });
    const rows = await W.db.account.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "New Name", industry: "Fitness", source: "HUBSPOT" });
  });

  it("an unknown owner leaves the account unassigned and is listed; a member's email maps", async () => {
    const W = await workspace("IngestOwner");
    const owners = await ingestBatch(W.hs, {
      kind: "owners",
      records: [
        { externalId: "o-admin", email: W.adminEmail, name: "Admin" },
        { externalId: "o-ghost", email: "ghost@elsewhere.test", name: "Ghost" },
      ],
    });
    expect(owners.counts).toMatchObject({ created: 1, unmatched: 1 });
    expect(owners.problems[0]?.reason).toMatch(/Ghost \(ghost@elsewhere.test\) is not an active/);
    const r = await ingestBatch(W.hs, {
      kind: "accounts",
      records: [
        { externalId: "a1", name: "Mapped", ownerExternalId: "o-admin" },
        { externalId: "a2", name: "Orphan", ownerExternalId: "o-ghost" },
      ],
    });
    expect(r.counts.created).toBe(2);
    expect(r.problems.map((p) => p.reason)).toEqual([
      expect.stringMatching(/Orphan: its owner in HubSpot is not matched/),
    ]);
    const byName = new Map((await W.db.account.findMany()).map((a) => [a.name, a]));
    expect(byName.get("Mapped")?.ownerMembershipId).toBe(W.actor.membershipId);
    expect(byName.get("Orphan")?.ownerMembershipId).toBeNull();
  });

  it("records failing validation are rejected with a plain reason; the rest of the batch lands", async () => {
    const W = await workspace("IngestReject");
    const r = await ingestBatch(W.hs, {
      kind: "accounts",
      records: [
        { externalId: "ok-1", name: "Fine" },
        { externalId: "bad-1", name: "" },
        { externalId: "bad-2", name: "Odd", domain: "not a domain" },
        { name: "No id" },
        { externalId: "ok-2", name: "Also fine" },
      ],
    });
    expect(r.counts).toMatchObject({ created: 2, rejected: 3 });
    expect(r.problems.map((p) => p.reason)).toEqual([
      "Account bad-1 has no name.",
      "Account bad-2 has a domain that is not valid.",
      expect.stringMatching(/^Account \(no id\)/),
    ]);
    expect(await W.db.account.count()).toBe(2);
  });

  it("archived records are counted and never create an account", async () => {
    const W = await workspace("IngestArchived");
    const r = await ingestBatch(W.hs, {
      kind: "accounts",
      records: [{ externalId: "gone", name: "Gone Co", archived: true }],
    });
    expect(r.counts).toMatchObject({ archived: 1, created: 0 });
    expect(await W.db.account.count()).toBe(0);
  });
});

describe("Q-32 / D1: fill empty fields, never overwrite another source", () => {
  it("a CSV account linked by domain gets empty fields filled and a CONFLICT for a differing name", async () => {
    const W = await workspace("IngestConflict");
    const csv = await W.db.account.create({
      data: {
        workspaceId: W.actor.workspaceId,
        name: "Sundial Fitness",
        domain: "sundial.fit",
        tier: "MID_TOUCH",
        source: "CSV",
      },
    });
    const batch = {
      kind: "accounts" as const,
      records: [
        {
          externalId: "hs-sundial",
          name: "Sundial Fitness Inc",
          domain: "sundial.fit",
          industry: "Fitness",
        },
      ],
    };
    const r = await ingestBatch(W.hs, batch);
    expect(r.counts).toMatchObject({ updated: 1, conflicts: 1, created: 0 });
    const after = await W.db.account.findUniqueOrThrow({ where: { id: csv.id } });
    expect(after).toMatchObject({ name: "Sundial Fitness", industry: "Fitness", source: "CSV" });
    expect(after.fieldSources).toEqual({ industry: "HUBSPOT" });
    const issues = await W.db.dataQualityIssue.findMany({ where: { kind: "CONFLICT" } });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ accountId: csv.id, status: "OPEN" });
    expect(issues[0]?.detail).toBe(
      'HubSpot says the name is "Sundial Fitness Inc", but here it is "Sundial Fitness" (set by a CSV import). Nothing was changed.',
    );
    // Re-sync: still one issue, nothing overwritten; a scan does not resolve sync conflicts.
    const again = await ingestBatch(W.hs, batch);
    expect(again.counts).toMatchObject({ unchanged: 1, conflicts: 1 });
    await runDataQualityScan(W.actor);
    const still = await W.db.dataQualityIssue.findMany({ where: { kind: "CONFLICT" } });
    expect(still.map((i) => i.status)).toEqual(["OPEN"]);
    // When HubSpot agrees again, the conflict resolves itself.
    await ingestBatch(W.hs, {
      kind: "accounts",
      records: [{ externalId: "hs-sundial", name: "Sundial Fitness", domain: "sundial.fit" }],
    });
    expect(
      (await W.db.dataQualityIssue.findFirstOrThrow({ where: { kind: "CONFLICT" } })).status,
    ).toBe("RESOLVED");
  });

  it("between two CRMs nothing is overwritten and the conflict names the earlier-connected one", async () => {
    const W = await workspace("IngestTwoCrm");
    await ingestBatch(W.hs, {
      kind: "accounts",
      records: [
        { externalId: "hs-1", name: "Orbit", domain: "orbit.example", industry: "Logistics" },
      ],
    });
    const r = await ingestBatch(W.sf, {
      kind: "accounts",
      records: [
        { externalId: "001SF", name: "Orbit", domain: "orbit.example", industry: "Shipping" },
      ],
    });
    expect(r.counts).toMatchObject({ conflicts: 1, created: 0 });
    expect((await W.db.account.findFirstOrThrow()).industry).toBe("Logistics");
    const issue = await W.db.dataQualityIssue.findFirstOrThrow({ where: { kind: "CONFLICT" } });
    expect(issue.detail).toMatch(
      /Salesforce says the industry is "Shipping".*set by HubSpot.*HubSpot was connected first/,
    );
  });
});

describe("billing customers are matched, never created (D-84)", () => {
  it("matches by domain or contact email, lists ambiguous and unknown ones, and links invoices", async () => {
    const W = await workspace("IngestBilling");
    const ws = W.actor.workspaceId;
    const acct = await W.db.account.create({
      data: { workspaceId: ws, name: "Sundial", domain: "sundial.fit", tier: "MID_TOUCH" },
    });
    const other = await W.db.account.create({
      data: { workspaceId: ws, name: "Halden", tier: "MID_TOUCH" },
    });
    await W.db.contact.create({
      data: { workspaceId: ws, accountId: other.id, name: "Pat", email: "pat@gmail.test" },
    });
    for (const n of ["Twin A", "Twin B"])
      await W.db.account.create({
        data: { workspaceId: ws, name: n, domain: "twin.example", tier: "LONG_TAIL" },
      });
    const customers = await ingestBatch(W.st, {
      kind: "customers",
      records: [
        { externalId: "cus_sun", name: "Sundial", email: "billing@sundial.fit" },
        { externalId: "cus_pat", email: "pat@gmail.test" },
        { externalId: "cus_twin", domain: "twin.example" },
        { externalId: "cus_none", email: "x@nowhere.test" },
      ],
    });
    expect(customers.counts).toMatchObject({ created: 2, unmatched: 2 });
    expect(await W.db.account.count()).toBe(4); // nothing created
    const invoices = {
      kind: "invoices" as const,
      records: [
        {
          externalId: "in_1",
          customerExternalId: "cus_sun",
          number: "SUN-0042",
          amountMinor: 129900,
          currency: "usd",
          issuedAt: "2026-10-01T00:00:00Z",
          dueAt: "2026-10-15T00:00:00Z",
          status: "FAILED",
          failureCount: 2,
          lastFailedAt: "2026-10-29T09:00:00Z",
        },
        {
          externalId: "in_2",
          customerExternalId: "cus_none",
          number: "NONE-1",
          amountMinor: 100,
          currency: "usd",
          issuedAt: "2026-10-01T00:00:00Z",
          dueAt: "2026-10-15T00:00:00Z",
          status: "OPEN",
        },
      ],
    };
    const r = await ingestBatch(W.st, invoices);
    expect(r.counts).toMatchObject({ created: 1, unmatched: 1 });
    expect(r.accountIds).toEqual([acct.id]);
    expect((await ingestBatch(W.st, invoices)).counts).toMatchObject({ created: 0, unchanged: 1 });
    const inv = await W.db.invoice.findFirstOrThrow();
    expect(inv).toMatchObject({
      accountId: acct.id,
      amountMinor: 129900n,
      status: "FAILED",
      source: "STRIPE",
    });
  });
});

describe("contracts derive ARR through the billing service", () => {
  it("a CRM deal becomes a contract and the account's ARR and tier follow it", async () => {
    const W = await workspace("IngestContract");
    await ingestBatch(W.hs, {
      kind: "accounts",
      records: [{ externalId: "c-1", name: "Deal Co" }],
    });
    const r = await ingestBatch(W.hs, {
      kind: "contracts",
      records: [
        {
          externalId: "deal-1",
          accountExternalId: "c-1",
          startDate: "2026-01-01T00:00:00Z",
          renewalDate: "2027-01-01T00:00:00Z",
          valueMinor: 6_000_000,
          currency: "USD",
        },
      ],
    });
    expect(r.counts.created).toBe(1);
    const a = await W.db.account.findFirstOrThrow();
    expect(a.arrMinor).toBe(6_000_000n);
  });
});

describe("tenancy (M5 rule 8)", () => {
  it("two workspaces syncing the same external ids get separate rows, and neither sees the other's", async () => {
    const batch = {
      kind: "accounts" as const,
      records: [{ externalId: "shared-1", name: "Shared Co" }],
    };
    const a = await ingestBatch(A.hs, batch);
    const b = await ingestBatch(B.hs, batch);
    expect(a.counts.created).toBe(1);
    expect(b.counts.created).toBe(1); // B's run did not "find" A's mapping
    expect(a.accountIds[0]).not.toBe(b.accountIds[0]);
    const aRefs = await A.db.externalRef.findMany({ where: { externalId: "shared-1" } });
    expect(aRefs.map((r) => r.internalId)).toEqual(a.accountIds);
    expect(await A.db.account.findUnique({ where: { id: b.accountIds[0]! } })).toBeNull();
    // A re-sync in A still maps to A's own account only.
    expect((await ingestBatch(A.hs, batch)).counts).toMatchObject({ created: 0, unchanged: 1 });
  });

  it("an ingest target naming another workspace's integration cannot write (composite FK)", async () => {
    await expect(
      ingestBatch(
        { ...A.hs, integrationId: B.hs.integrationId },
        {
          kind: "accounts",
          records: [{ externalId: "x-1", name: "X" }],
        },
      ),
    ).rejects.toThrow();
    expect(await A.db.account.findFirst({ where: { name: "X" } })).toBeNull();
  });
});

describe("query budget (acceptance #14)", () => {
  it("500 new accounts and a 500-account re-sync each take a fixed number of queries", async () => {
    const W = await workspace("IngestBudget");
    const batch = { kind: "accounts" as const, records: companies(500, "budget") };
    const first = await countQueries(() => ingestBatch(W.hs, batch));
    expect(first.result.counts.created).toBe(500);
    expect(first.queries).toBeLessThanOrEqual(12);
    const second = await countQueries(() => ingestBatch(W.hs, batch));
    expect(second.result.counts.unchanged).toBe(500);
    expect(second.queries).toBeLessThanOrEqual(12);
    expect(
      await rawDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${W.actor.workspaceId}, true)`;
        return tx.account.count();
      }),
    ).toBe(500);
  });
});
