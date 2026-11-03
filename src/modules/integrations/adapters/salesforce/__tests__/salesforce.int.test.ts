import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { openCredentials, sealCredentials } from "../../../credentials";
import {
  createFixtureTransport,
  loadFixture,
  type FixtureTransport,
} from "../../../fixture-transport";
import { runSync } from "../../../sync.jobs";
import {
  executeApprovedWriteBack,
  requestWriteBack,
  setWriteBack,
} from "../../../writeback.service";

/**
 * Salesforce on the database, fixture transport only: sync twice changes nothing (M5 rule 2),
 * the Q-32 conflict when HubSpot was connected first, an expired session refreshed once and the
 * sync completed, and the owner write-back through the gate (fake transport, founder D2).
 */
const NOW = new Date("2026-11-02T15:00:00Z");
const INSTANCE = "https://larkspur-dev.my.salesforce.test";
const FILES = [
  "auth",
  "session-expired",
  "users",
  "accounts",
  "contacts",
  "opportunities",
  "writeback",
];

async function setup(label: string, accessToken = "fixture-sf-access-not-a-secret") {
  const { actor } = await createTestAdmin(label);
  const ws = actor.workspaceId;
  const db = scopedDb(actor);
  const tag = `${label.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const members: Record<string, string> = {};
  for (const key of ["aisha", "leo"]) {
    const user = await rawDb.user.create({
      data: { email: `${key}-${tag}@larkspur.test`, name: key },
    });
    members[key] = (
      await rawDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return tx.membership.create({ data: { workspaceId: ws, userId: user.id, role: "CSM" } });
      })
    ).id;
  }
  const halden = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Halden Retail",
      domain: "halden-retail.test",
      tier: "MID_TOUCH",
      industry: "Retail",
      source: "SEED",
    },
  });
  const brightwell = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Brightwell Logistics",
      domain: "brightwell-logistics.test",
      tier: "HIGH_TOUCH",
      source: "HUBSPOT",
      fieldSources: { industry: "HUBSPOT" },
      industry: "Logistics And Supply Chain",
    },
  });
  // HubSpot connected first: it is primary between the two CRMs.
  await db.integration.create({
    data: { workspaceId: ws, provider: "HUBSPOT", connectedAt: new Date("2026-10-01T00:00:00Z") },
  });
  const integration = await db.integration.create({
    data: {
      workspaceId: ws,
      provider: "SALESFORCE",
      connectedAt: new Date("2026-10-20T00:00:00Z"),
      credentialsEnc: sealCredentials({
        accessToken,
        refreshToken: "fixture-sf-refresh-not-a-secret",
        instanceUrl: INSTANCE,
      }),
    },
  });
  const transport = (): FixtureTransport => {
    const t = createFixtureTransport(FILES.flatMap((f) => loadFixture("salesforce", f)));
    const original = t.request.bind(t);
    return Object.assign(t, {
      request: async (req: Parameters<typeof original>[0]) => {
        const res = await original(req);
        const body = JSON.stringify(res.body)
          .replaceAll("aisha@larkspur.test", `aisha-${tag}@larkspur.test`)
          .replaceAll("leo@larkspur.test", `leo-${tag}@larkspur.test`);
        return { ...res, body: JSON.parse(body) as unknown };
      },
    });
  };
  const payload = (runKey: string) => ({
    workspaceId: ws,
    integrationId: integration.id,
    kind: "FULL" as const,
    trigger: "MANUAL" as const,
    runKey,
  });
  return { actor, db, members, halden, brightwell, integration, transport, payload };
}

describe("Salesforce on the database (fixture transport)", () => {
  it("links by website, raises the conflict naming HubSpot as primary, fills empty fields; a second sync changes nothing", async () => {
    const S = await setup("SfSync");
    const deps = { transport: S.transport, clock: () => NOW };
    const first = await runSync(S.payload("one"), deps);
    expect(first.status).toBe("SUCCEEDED");
    expect(first.counts).toMatchObject({ archived: 2, conflicts: 1 }); // Brightwell's industry
    const halden = await S.db.account.findUniqueOrThrow({ where: { id: S.halden.id } });
    expect(halden).toMatchObject({ ownerMembershipId: S.members.leo, industry: "Retail" });
    const pinecrest = await S.db.account.findFirstOrThrow({ where: { name: "Pinecrest Health" } });
    expect(pinecrest).toMatchObject({
      domain: "pinecrest-health.test",
      ownerMembershipId: S.members.aisha,
      source: "SALESFORCE",
    });
    const issues = await S.db.dataQualityIssue.findMany({
      where: { kind: "CONFLICT", accountId: S.brightwell.id },
    });
    const industry = issues.find((i) => i.detail.includes("industry"))!;
    expect(industry.detail).toBe(
      'Salesforce says the industry is "Transportation", but here it is "Logistics And Supply Chain" (set by HubSpot). Nothing was changed. HubSpot was connected first, so the rule prefers its value.',
    );
    expect(await S.db.account.count({ where: { name: "Gone Industries" } })).toBe(0);

    const before = [
      await S.db.account.count(),
      await S.db.contact.count(),
      await S.db.externalRef.count(),
      await S.db.dataQualityIssue.count(),
    ];
    const second = await runSync(S.payload("two"), deps);
    expect(second.counts).toMatchObject({ created: 0, updated: 0 });
    expect([
      await S.db.account.count(),
      await S.db.contact.count(),
      await S.db.externalRef.count(),
      await S.db.dataQualityIssue.count(),
    ]).toEqual(before);
  });

  it("an expired session is refreshed once, stored sealed, and the sync completes", async () => {
    const S = await setup("SfExpired", "fixture-sf-expired");
    const t = S.transport();
    const r = await runSync(S.payload("one"), { transport: () => t, clock: () => NOW });
    expect(r.status).toBe("SUCCEEDED");
    expect(t.calls.filter((c) => c.url.endsWith("/services/oauth2/token"))).toHaveLength(1);
    const row = await S.db.integration.findUniqueOrThrow({ where: { id: S.integration.id } });
    expect(row.credentialsEnc).not.toContain("fixture-sf-access-refreshed");
    expect(openCredentials(row.credentialsEnc).accessToken).toBe("fixture-sf-access-refreshed");
    expect(row.status).toBe("CONNECTED");
  });

  it("owner write-back goes through the gate and PATCHes Salesforce on the fake transport", async () => {
    const S = await setup("SfWriteBack");
    await runSync(S.payload("one"), { transport: S.transport, clock: () => NOW });
    await setWriteBack(S.actor, S.integration.id, { enabled: true, fields: ["ownerMembershipId"] });
    const { approvalId } = await requestWriteBack(S.actor, S.integration.id, {
      field: "ownerMembershipId",
      accountId: S.halden.id,
      value: S.members.aisha,
    });
    await S.db.approval.update({
      where: { id: approvalId },
      data: {
        status: "APPROVED",
        decidedById: S.actor.membershipId,
        decidedAt: new Date(),
        decidedVia: "APP",
      },
    });
    const t = S.transport();
    expect(
      (
        await executeApprovedWriteBack(S.actor, approvalId, {
          transport: () => t,
          clock: () => NOW,
        })
      ).status,
    ).toBe("PUSHED");
    expect(t.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "PATCH /services/data/v61.0/sobjects/Account/0015f00000HALDN",
    ]);
  });
});
