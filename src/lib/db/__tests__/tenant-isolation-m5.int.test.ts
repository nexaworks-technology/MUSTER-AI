import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { findIntegrationForWebhook, findSlackIntegrationByTeam } from "@/lib/db/inbound";
import { createTestAdmin } from "@/test/fixtures";
import { expectUpdateIsolated } from "./update-attack";

/**
 * Rule 2 for the M5 integration models (M5 rule 8). Kept in its own file, like M3 and M4.
 * Every model gets read, real-field update (with its own-row control), delete and raw-SQL attacks,
 * plus composite FKs that refuse references into another workspace, and the two inbound lookup
 * policies are shown to admit exactly one row, read-only.
 */
type Side = Awaited<ReturnType<typeof setup>>;
let A: Side;
let B: Side;

/** Both workspaces connect the SAME external accounts on purpose (M5 rule 8). */
const SHARED_PORTAL = "portal-4242";
/** Unique per run: global lookups must not see earlier runs' rows. */
const RUN = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();

async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const workspaceId = actor.workspaceId;
  const db = scopedDb(actor);
  const integration = await db.integration.create({
    data: {
      workspaceId,
      provider: "HUBSPOT",
      externalAccountId: SHARED_PORTAL,
      connectedByMembershipId: actor.membershipId,
      credentialsEnc: `k1.sealed-${label}`,
    },
  });
  const slack = await db.integration.create({
    data: { workspaceId, provider: "SLACK", externalAccountId: `T${RUN}${label.at(-1)}` },
  });
  const syncJob = await db.syncJob.create({
    data: {
      workspaceId,
      integrationId: integration.id,
      kind: "FULL",
      trigger: "MANUAL",
      runKey: `run-${label}`,
    },
  });
  const webhookEvent = await db.webhookEvent.create({
    data: {
      workspaceId,
      integrationId: integration.id,
      externalEventId: "evt_shared_1",
      eventType: "invoice.payment_failed",
      payloadStorageKey: `ws/${workspaceId}/webhooks/x.json`,
    },
  });
  const link = await db.slackUserLink.create({
    data: {
      workspaceId,
      integrationId: slack.id,
      slackUserId: "U0SAME",
      membershipId: actor.membershipId,
      email: actor.user.email,
    },
  });
  return { actor, workspaceId, db, integration, slack, syncJob, webhookEvent, link };
}

beforeAll(async () => {
  A = await setup("TenantM5A");
  B = await setup("TenantM5B");
});

const CASES = [
  { model: "Integration", delegate: "integration", row: (s: Side) => s.integration },
  { model: "SyncJob", delegate: "syncJob", row: (s: Side) => s.syncJob },
  { model: "WebhookEvent", delegate: "webhookEvent", row: (s: Side) => s.webhookEvent },
  { model: "SlackUserLink", delegate: "slackUserLink", row: (s: Side) => s.link },
] as const;

const fk = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";

describe("tenant isolation — M5 integration models (Rule 2)", () => {
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

  it("the same external account and event ids in two workspaces stay two separate rows", async () => {
    expect(A.integration.externalAccountId).toBe(B.integration.externalAccountId);
    expect(A.webhookEvent.externalEventId).toBe(B.webhookEvent.externalEventId);
    const seen = await A.db.integration.findMany({ where: { externalAccountId: SHARED_PORTAL } });
    expect(seen.map((i) => i.id)).toEqual([A.integration.id]);
  });

  it("sync jobs, webhook events and external refs cannot point at B's integration (composite FK)", async () => {
    await expect(
      A.db.syncJob.create({
        data: {
          workspaceId: A.workspaceId,
          integrationId: B.integration.id,
          kind: "FULL",
          trigger: "MANUAL",
          runKey: "attack",
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.webhookEvent.create({
        data: {
          workspaceId: A.workspaceId,
          integrationId: B.integration.id,
          externalEventId: "evt_attack",
          eventType: "x",
          payloadStorageKey: "k",
        },
      }),
    ).rejects.toSatisfy(fk);
    await expect(
      A.db.externalRef.create({
        data: {
          workspaceId: A.workspaceId,
          integrationId: B.integration.id,
          source: "HUBSPOT",
          objectType: "company",
          externalId: "attack",
          internalType: "Account",
          internalId: "x",
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("a Slack link cannot map to B's member (composite FK)", async () => {
    await expect(
      A.db.slackUserLink.create({
        data: {
          workspaceId: A.workspaceId,
          integrationId: A.slack.id,
          slackUserId: "U0ATTACK",
          membershipId: B.actor.membershipId,
          email: "x@x.test",
        },
      }),
    ).rejects.toSatisfy(fk);
  });

  it("the webhook lookup admits exactly the named integration, and only for reading", async () => {
    const found = await findIntegrationForWebhook(A.integration.id);
    expect(found).toMatchObject({ id: A.integration.id, workspaceId: A.workspaceId });
    expect(await findIntegrationForWebhook("not-an-id")).toBeNull();
    // With the lookup setting, nothing else is visible and nothing can be written.
    const [, others, updated] = await rawDb.$transaction([
      rawDb.$executeRaw`SELECT set_config('app.webhook_integration_id', ${A.integration.id}, true)`,
      rawDb.integration.count({ where: { id: { not: A.integration.id } } }),
      rawDb.integration.updateMany({
        where: { id: A.integration.id },
        data: { lastErrorPlain: "attack" },
      }),
    ]);
    expect(others).toBe(0);
    expect(updated.count).toBe(0);
    const [, jobs] = await rawDb.$transaction([
      rawDb.$executeRaw`SELECT set_config('app.webhook_integration_id', ${A.integration.id}, true)`,
      rawDb.syncJob.count(),
    ]);
    expect(jobs).toBe(0);
  });

  it("the Slack team lookup finds only that team's Slack integration", async () => {
    expect(await findSlackIntegrationByTeam(A.slack.externalAccountId!)).toMatchObject({
      id: A.slack.id,
      workspaceId: A.workspaceId,
    });
    expect(await findSlackIntegrationByTeam(SHARED_PORTAL)).toBeNull(); // a HubSpot id, wrong shape
  });

  it("a Slack team connected to two workspaces resolves to neither", async () => {
    const team = `T${RUN}DUP`;
    for (const s of [A, B])
      await s.db.integration.update({
        where: { id: s.slack.id },
        data: { externalAccountId: team },
      });
    expect(await findSlackIntegrationByTeam(team)).toBeNull();
    await B.db.integration.update({
      where: { id: B.slack.id },
      data: { externalAccountId: `T${RUN}B` },
    });
    expect(await findSlackIntegrationByTeam(team)).toMatchObject({ workspaceId: A.workspaceId });
    await A.db.integration.update({
      where: { id: A.slack.id },
      data: { externalAccountId: `T${RUN}A` },
    });
  });

  it("the database refuses credentials on a disconnected integration and write-back fields with the switch off", async () => {
    await expect(
      A.db.integration.update({
        where: { id: A.integration.id },
        data: { status: "DISCONNECTED" },
      }),
    ).rejects.toThrow(/integration_disconnected_no_credentials/);
    await expect(
      A.db.integration.update({
        where: { id: A.integration.id },
        data: { writeBackFields: ["ownerMembershipId"] },
      }),
    ).rejects.toThrow(/integration_writeback_fields_need_switch/);
  });
});
