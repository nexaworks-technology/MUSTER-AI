import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { sealCredentials } from "../../../credentials";
import { createFixtureTransport, loadFixture } from "../../../fixture-transport";
import { runSync } from "../../../sync.jobs";
import {
  executeApprovedWriteBack,
  requestWriteBack,
  setWriteBack,
} from "../../../writeback.service";

/**
 * HubSpot on the database, fixture transport only: owner mapping by member email with unmatched
 * owners listed (never guessed), sync twice changes nothing (M5 rule 2), the Q-32 conflict on a
 * differing company name, and the owner write-back pushed only through the gate after approval.
 */
const NOW = new Date("2026-11-02T15:00:00Z");
const world = () =>
  createFixtureTransport(
    ["auth", "owners", "companies", "contacts", "deals", "writeback"].flatMap((f) =>
      loadFixture("hubspot", f),
    ),
  );

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const tag = `${label.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const ws = actor.workspaceId;
  const db = scopedDb(actor);
  // Two CSMs whose emails HubSpot's owners use (the demo's Aisha and Leo).
  const members: Record<string, string> = {};
  for (const [key, email] of [
    ["aisha", `aisha-${tag}@larkspur.test`],
    ["leo", `leo-${tag}@larkspur.test`],
  ]) {
    const user = await rawDb.user.create({ data: { email: email!, name: key } });
    const m = await rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return tx.membership.create({ data: { workspaceId: ws, userId: user.id, role: "CSM" } });
    });
    members[key!] = m.id;
  }
  const brightwell = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Brightwell Logistics",
      domain: "brightwell-logistics.test",
      tier: "HIGH_TOUCH",
      source: "SEED",
    },
  });
  const sundial = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Sundial Fitness",
      domain: "sundial-fitness.test",
      tier: "LONG_TAIL",
      source: "SEED",
    },
  });
  await db.contact.create({
    data: {
      workspaceId: ws,
      accountId: sundial.id,
      name: "Jo Harper",
      email: "jo.harper@sundial-fitness.test",
      source: "SEED",
    },
  });
  const integration = await db.integration.create({
    data: {
      workspaceId: ws,
      provider: "HUBSPOT",
      credentialsEnc: sealCredentials({
        accessToken: "fixture-access-token-not-a-secret",
        refreshToken: "fixture-refresh-token-not-a-secret",
        expiresAt: "2026-11-02T16:00:00Z",
      }),
    },
  });
  // The fixture owners use the demo's addresses; point them at this test's members.
  const transport = () => {
    const t = world();
    const original = t.request.bind(t);
    return Object.assign(t, {
      request: async (req: Parameters<typeof original>[0]) => {
        const res = await original(req);
        const text = JSON.stringify(res.body)
          .replaceAll("aisha@larkspur.test", `aisha-${tag}@larkspur.test`)
          .replaceAll("leo@larkspur.test", `leo-${tag}@larkspur.test`);
        return { ...res, body: JSON.parse(text) as unknown };
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
  return { actor, db, members, brightwell, sundial, integration, transport, payload };
}

describe("HubSpot on the database (fixture transport)", () => {
  it("maps owners by email, lists the unknown one, links by domain, raises the Brightwell conflict; a second sync changes nothing", async () => {
    const S = await setup("HsSync");
    const deps = { transport: S.transport, clock: () => NOW };
    const first = await runSync(S.payload("one"), deps);
    expect(first.status).toBe("SUCCEEDED");
    expect(first.counts).toMatchObject({ conflicts: 1, archived: 1 });

    const accounts = new Map((await S.db.account.findMany()).map((a) => [a.name, a]));
    // Brightwell: linked by domain, name kept (conflict), empty fields filled, owner Leo filled.
    expect(accounts.get("Brightwell Logistics")).toMatchObject({
      id: S.brightwell.id,
      ownerMembershipId: S.members.leo,
      industry: "Logistics And Supply Chain",
      employeeBand: "201-1000",
      source: "SEED",
    });
    expect(accounts.has("Brightwell Logistics Inc.")).toBe(false);
    // Meridian: new, its owner is not a member here → unassigned, listed.
    expect(accounts.get("Meridian Labs")).toMatchObject({
      ownerMembershipId: null,
      source: "HUBSPOT",
    });
    expect(accounts.has("Old Co")).toBe(false);
    const job = await S.db.syncJob.findUniqueOrThrow({ where: { id: first.syncJobId! } });
    const problems = JSON.stringify(job.counts);
    expect(problems).toContain(
      "Former Rep (former.rep@larkspur.test) is not an active admin, CS leader or CSM here",
    );
    expect(problems).toContain("Account c-1004 has no name.");
    expect(problems).toContain("Free Agent: their company is not in this sync");
    expect(problems).toContain("Contact p-4 has an email address that is not valid.");

    const conflict = await S.db.dataQualityIssue.findFirstOrThrow({ where: { kind: "CONFLICT" } });
    expect(conflict).toMatchObject({ accountId: S.brightwell.id, status: "OPEN" });
    expect(conflict.detail).toBe(
      'HubSpot says the name is "Brightwell Logistics Inc.", but here it is "Brightwell Logistics" (set by the demo data). Nothing was changed.',
    );
    // Jo Harper linked by email to the existing contact, not duplicated.
    expect(await S.db.contact.count({ where: { email: "jo.harper@sundial-fitness.test" } })).toBe(
      1,
    );

    const before = {
      accounts: await S.db.account.count(),
      contacts: await S.db.contact.count(),
      refs: await S.db.externalRef.count(),
      issues: await S.db.dataQualityIssue.count(),
    };
    const second = await runSync(S.payload("two"), deps);
    expect(second.counts).toMatchObject({ created: 0, updated: 0 });
    expect({
      accounts: await S.db.account.count(),
      contacts: await S.db.contact.count(),
      refs: await S.db.externalRef.count(),
      issues: await S.db.dataQualityIssue.count(),
    }).toEqual(before);
  });

  it("owner write-back: off by default; once allowed, approval then a push through the fake transport", async () => {
    const S = await setup("HsWriteBack");
    await runSync(S.payload("one"), { transport: S.transport, clock: () => NOW });
    const change = {
      field: "ownerMembershipId",
      accountId: S.brightwell.id,
      value: S.members.aisha,
    };
    await expect(requestWriteBack(S.actor, S.integration.id, change)).rejects.toThrow(
      /Write-back is off for HubSpot/,
    );
    await setWriteBack(S.actor, S.integration.id, { enabled: true, fields: ["ownerMembershipId"] });
    const { approvalId } = await requestWriteBack(S.actor, S.integration.id, change);
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
    const r = await executeApprovedWriteBack(S.actor, approvalId, {
      transport: () => t,
      clock: () => NOW,
    });
    expect(r).toEqual({ status: "PUSHED", plain: `Updated in HubSpot (approval ${approvalId}).` });
    expect(t.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "PATCH /crm/v3/objects/companies/c-1001",
    ]);
    expect(JSON.parse(t.calls[0]!.body!)).toEqual({ properties: { hubspot_owner_id: "101" } });
  });
});
