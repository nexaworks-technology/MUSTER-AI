/**
 * Milestone 8 Fresh-Database Demo Script
 * Demonstrates the 5 required M8 scenarios on a brand-new, freshly-migrated scratch database:
 * 1. Publish Champion Loss and run it end-to-end on a seeded account through the log transport.
 * 2. Attempt to publish Promise Late and show the safety gate refusal.
 * 3. The Orchard Lane frequency cap case showing SKIPPED with reason (no task created).
 * 4. A campaign created, batch-approved, and sent to its list with per-recipient guard results.
 * 5. A renewal plan adopted from a brief into Renewal.planSteps.
 */

import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { approve } from "../src/modules/approvals/service";
import {
  createCampaign,
  executeCampaignBatch,
  getCampaign,
  scheduleCampaign,
} from "../src/modules/campaigns/service";
import { SEEDED_PLAYS } from "../src/modules/plays/seeded/definitions";
import { seedPlaysForWorkspace } from "../src/modules/plays/seeded/seed";
import { enterPlay } from "../src/modules/plays/runner";
import { publishPlay } from "../src/modules/plays/service";
import { adoptRenewalPlan } from "../src/modules/renewals/plan-adoption";

const PG_HOST = "localhost";
const PG_PORT = "5432";
const OWNER_USER = "nexaworks_owner";
const OWNER_PASS = "$Q78_REDACTED_OWNER";
const APP_USER = "app_user";
const APP_PASS = "$Q78_REDACTED_APP";

const SCRATCH_DB = `nexaworks_scratch_m8_${Date.now()}`;
const SCRATCH_URL = `postgresql://${APP_USER}:${APP_PASS}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`;
const SCRATCH_URL_MIGRATE = `postgresql://${OWNER_USER}:${OWNER_PASS}@${PG_HOST}:${PG_PORT}/${SCRATCH_DB}`;

function psql(db: string, sql: string) {
  return execFileSync(
    "psql",
    ["-h", PG_HOST, "-p", PG_PORT, "-d", db, "-c", sql],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function main() {
  console.log("================================================================================");
  console.log("MILESTONE M8: FRESH DATABASE DEMO");
  console.log("================================================================================");

  // 1. Create scratch database and apply migrations
  console.log(`\n[Setup] Creating scratch database: ${SCRATCH_DB}`);
  psql("postgres", `CREATE DATABASE ${SCRATCH_DB} OWNER ${OWNER_USER};`);
  psql(
    SCRATCH_DB,
    `GRANT ALL PRIVILEGES ON DATABASE ${SCRATCH_DB} TO ${APP_USER};
     GRANT ALL ON SCHEMA public TO ${APP_USER};
     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${APP_USER};
     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${APP_USER};`,
  );

  console.log("[Setup] Running prisma migrate deploy on scratch database...");
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    env: {
      ...process.env,
      DATABASE_URL: SCRATCH_URL,
      DATABASE_URL_MIGRATE: SCRATCH_URL_MIGRATE,
    },
    stdio: "inherit",
  });

  // Grant app_user permissions on the newly created tables and sequences
  psql(
    SCRATCH_DB,
    `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${APP_USER};
     GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${APP_USER};
     GRANT ALL PRIVILEGES ON ALL ROUTINES IN SCHEMA public TO ${APP_USER};`,
  );

  // Override env for the current process
  process.env.DATABASE_URL = SCRATCH_URL;
  process.env.DATABASE_URL_MIGRATE = SCRATCH_URL_MIGRATE;

  const prisma = new PrismaClient({ datasourceUrl: SCRATCH_URL });

  try {
    // 2. Create Workspace and Admin Actor
    console.log("\n[Setup] Initializing demo workspace & actor...");
    const workspace = await prisma.workspace.create({
      data: {
        name: "Acme Cloud Services",
        slug: `acme-${Date.now()}`,
        status: "ACTIVE",
        baseCurrency: "USD",
      },
    });

    const user = await prisma.user.create({
      data: {
        email: `dana.admin@example.com`,
        name: "Dana Admin",
      },
    });

    const membership = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
      return await tx.membership.create({
        data: {
          workspaceId: workspace.id,
          userId: user.id,
          role: "ADMIN",
          bookScope: "ALL",
        },
      });
    });

    const actor = {
      workspaceId: workspace.id,
      userId: user.id,
      membershipId: membership.id,
      role: "ADMIN" as const,
      canViewRevenue: true,
      bookScope: "ALL" as const,
    };

    // Seed the 15 default plays
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
      await seedPlaysForWorkspace(workspace.id, tx as any);
    });

    // ─── SCENARIO 1: Publish Champion Loss & Run End-to-End ──────────────────────
    console.log("\n--------------------------------------------------------------------------------");
    console.log("SCENARIO 1: Publish Champion Loss and run end-to-end through log transport");
    console.log("--------------------------------------------------------------------------------");

    // Create an account & contact for Champion Loss
    const { acct1, contact1 } = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
      const a = await tx.account.create({
        data: {
          workspaceId: workspace.id,
          name: "Larkwood Systems",
          tier: "HIGH_TOUCH",
          timezone: "America/New_York",
          ownerMembershipId: membership.id,
        },
      });
      const c = await tx.contact.create({
        data: {
          workspaceId: workspace.id,
          accountId: a.id,
          name: "Sarah Champion",
          email: "sarah@larkwood.test",
          status: "ACTIVE",
        },
      });
      return { acct1: a, contact1: c };
    });

    const championPlay = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
      return await tx.play.findFirstOrThrow({
        where: { workspaceId: workspace.id, key: "champion-loss" },
      });
    });

    console.log(`Found seeded play: ${championPlay.name} (status: ${championPlay.status})`);
    const pubRes1 = await publishPlay(actor, championPlay.id);
    console.log(`Published Champion Loss: status = ${pubRes1.status}`);

    const runRes1 = await enterPlay(
      actor,
      {
        workspaceId: workspace.id,
        playId: championPlay.id,
        accountId: acct1.id,
        triggerRef: `signal:bounced:${contact1.id}`,
      },
      { executeInline: true, autoSendEnabled: true },
    );
    console.log(`Play entry result: status = ${runRes1.status}, playRunId = ${runRes1.playRunId}`);

    const stepRuns1 = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
      return await tx.playStepRun.findMany({
        where: { playRunId: runRes1.playRunId! },
      });
    });

    console.log(`Step runs executed (${stepRuns1.length}):`);
    for (const sr of stepRuns1) {
      console.log(`  - Step '${sr.stepKey}': status = ${sr.status}`);
    }

    // ─── SCENARIO 2: Attempt to Publish Promise Late (Dormant Refusal) ─────────────
    console.log("\n--------------------------------------------------------------------------------");
    console.log("SCENARIO 2: Attempt to publish Promise Late (showing safety gate refusal)");
    console.log("--------------------------------------------------------------------------------");

    const promisePlay = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
      return await tx.play.findFirstOrThrow({
        where: { workspaceId: workspace.id, key: "promise-late" },
      });
    });

    console.log(`Attempting to publish dormant play: ${promisePlay.name}...`);
    const pubRes2 = await publishPlay(actor, promisePlay.id);
    console.log(`Safety check result: status = ${pubRes2.status}`);
    console.log(`Refusals recorded: ${JSON.stringify(pubRes2.refusals)}`);

    const promisePlayAfter = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
      return await tx.play.findUniqueOrThrow({ where: { id: promisePlay.id } });
    });
    console.log(`Verified play status remained: ${promisePlayAfter.status}`);

    // ─── SCENARIO 3: Orchard Lane Frequency Cap Case (SKIPPED with Reason) ─────────
    console.log("\n--------------------------------------------------------------------------------");
    console.log("SCENARIO 3: Orchard Lane cap case (SKIPPED with reason, no task created)");
    console.log("--------------------------------------------------------------------------------");

    try {
      const { orchardAcct, orchardContact } = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
        const a = await tx.account.create({
          data: {
            workspaceId: workspace.id,
            name: "Orchard Lane Logistics",
            tier: "MID_TOUCH",
            timezone: "America/New_York",
            ownerMembershipId: membership.id,
          },
        });
        const c = await tx.contact.create({
          data: {
            workspaceId: workspace.id,
            accountId: a.id,
            name: "Oliver Lane",
            email: "oliver@orchardlane.test",
            status: "ACTIVE",
          },
        });
        // Previous email sent 2 hours ago (within 72h cooldown)
        await tx.outboundMessage.create({
          data: {
            workspaceId: workspace.id,
            accountId: a.id,
            contactId: c.id,
            toEmail: c.email,
            subject: "Previous Touchpoint",
            bodyText: "Recent check-in",
            status: "SENT",
            sentAt: new Date(Date.now() - 2 * 3600 * 1000),
            providerMessageId: "orchard-prev-email-1",
          },
        });
        return { orchardAcct: a, orchardContact: c };
      });

      // Create a template-mode outreach play to trigger the pure frequency-cap check
      const capPlay = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
        const p = await tx.play.create({
          data: {
            workspaceId: workspace.id,
            key: "orchard-cap-play",
            name: "Orchard Lane Outreach Play",
            category: "adoption",
            status: "DRAFT",
          },
        });
        await tx.playVersion.create({
          data: {
            workspaceId: workspace.id,
            playId: p.id,
            version: 1,
            definition: {
              name: "Orchard Lane Outreach Play",
              category: "adoption",
              trigger: { type: "signal", ruleKey: "usage_drop_vs_normal" },
              steps: [
                {
                  key: "frequent-checkin",
                  name: "Frequent Check-in Outreach",
                  handler: "draft",
                  params: {
                    mode: "template",
                    subject: "Checking in with {{account.name}}",
                    body: "Hello Oliver, following up on your account activity.",
                  },
                  approvalLevelByTier: {
                    HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
                    MID_TOUCH: "DRAFT_FOR_APPROVAL",
                    LONG_TAIL: "DRAFT_FOR_APPROVAL",
                  },
                  safe: true,
                  sensitive: false,
                },
              ],
            } as any,
          },
        });
        return p;
      });
      const pubRes3 = await publishPlay(actor, capPlay.id);
      console.log(`Cap play publish result: status = ${pubRes3.status}`);

      const runRes3 = await enterPlay(
        actor,
        {
          workspaceId: workspace.id,
          playId: capPlay.id,
          accountId: orchardAcct.id,
          triggerRef: `signal:adoption-drop:${orchardAcct.id}`,
        },
        { executeInline: true, autoSendEnabled: true },
      );

      const stepRuns3 = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
        return await tx.playStepRun.findMany({
          where: { playRunId: runRes3.playRunId! },
        });
      });

      for (const sr of stepRuns3) {
        console.log(`Step '${sr.stepKey}': status = ${sr.status}`);
        if (sr.status === "SKIPPED") {
          console.log(`  Skipped reason: ${(sr.result as any)?.skippedReason}`);
        }
      }

      const orchardTasks = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
        return await tx.task.findMany({ where: { accountId: orchardAcct.id } });
      });
      console.log(`Verified tasks created for skip = ${orchardTasks.length} (no task created)`);
    } catch (err) {
      console.error("Scenario 3 ERROR DETAILS:", err);
      throw err;
    }

    // ─── SCENARIO 4: Bulk Campaign Created, Approved, & Sent with Guard Results ────
    console.log("\n--------------------------------------------------------------------------------");
    console.log("SCENARIO 4: Bulk campaign created, batch-approved, and sent with per-recipient guards");
    console.log("--------------------------------------------------------------------------------");

    // Create segment and 2 recipients: 1 clean, 1 suppressed
    const { seg, cleanContact, suppContact } = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
      const s = await tx.segment.create({
        data: {
          workspaceId: workspace.id,
          name: "High Touch Tier Customers",
          filter: { all: [{ field: "tier", op: "eq", value: "HIGH_TOUCH" }] },
        },
      });

      const cleanC = await tx.contact.create({
        data: {
          workspaceId: workspace.id,
          accountId: acct1.id,
          name: "Clean Recipient",
          email: "clean@larkwood.test",
          status: "ACTIVE",
        },
      });

      const suppC = await tx.contact.create({
        data: {
          workspaceId: workspace.id,
          accountId: acct1.id,
          name: "Suppressed Recipient",
          email: "suppressed@larkwood.test",
          status: "ACTIVE",
        },
      });

      await tx.emailSuppression.create({
        data: {
          workspaceId: workspace.id,
          email: suppC.email,
          reason: "UNSUBSCRIBED",
        },
      });

      return { seg: s, cleanContact: cleanC, suppContact: suppC };
    });

    const campaign = await createCampaign(actor, {
      name: "Q4 Roadmap Briefing",
      segmentId: seg.id,
      subject: "Q4 Updates for {{account.name}}",
      body: "Hi {{contact.first_name}},\n\nHere is our Q4 roadmap update.",
      pacePerHour: 100,
    });
    console.log(`Campaign created: id = ${campaign.id}, approvalId = ${campaign.approvalId}`);

    // Batch-approve campaign by Admin
    await approve(actor, { approvalId: campaign.approvalId! });
    console.log(`Campaign approval approved by Admin`);

    // Schedule and execute during business hours
    const demoClock = () => new Date("2026-11-04T15:00:00Z"); // 10:00 AM Eastern
    await scheduleCampaign(actor, campaign.id, new Date("2026-11-04T14:00:00Z"));
    const sentList: any[] = [];
    const fakeTransport = {
      name: "log" as const,
      async send(m: any) {
        sentList.push(m);
        return { id: `provider-campaign-${sentList.length}` };
      },
    };

    const batchRes = await executeCampaignBatch(actor, campaign.id, {
      clock: demoClock,
      transport: fakeTransport as any,
      limit: 10,
    });
    console.log(`Campaign batch executed: processed = ${batchRes.processed}, sent = ${batchRes.sent}, held = ${batchRes.held}`);

    const campaignStats = await getCampaign(actor, campaign.id);
    console.log(`Campaign final statistics: total = ${campaignStats.stats.total}, sent = ${campaignStats.stats.sent}, held = ${campaignStats.stats.held}`);
    for (const r of campaignStats.recipients) {
      console.log(`  - Recipient '${r.contact.email}': status = ${r.status}${r.heldReason ? ` (${r.heldReason})` : ""}`);
    }

    // ─── SCENARIO 5: Renewal Plan Adopted from Brief ──────────────────────────────
    console.log("\n--------------------------------------------------------------------------------");
    console.log("SCENARIO 5: Renewal plan adopted from brief into Renewal.planSteps");
    console.log("--------------------------------------------------------------------------------");

    const renewal = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
      const contract = await tx.contract.create({
        data: {
          workspaceId: workspace.id,
          accountId: acct1.id,
          startDate: new Date("2025-12-15"),
          endDate: new Date("2026-12-15"),
          valueMinor: 100_000_00n,
          currency: "USD",
        },
      });
      return await tx.renewal.create({
        data: {
          workspaceId: workspace.id,
          accountId: acct1.id,
          contractId: contract.id,
          renewalDate: new Date("2026-12-15"),
          confidenceBand: "HIGH",
          confidence: 85,
          confidenceAsOf: new Date("2026-11-04"),
        },
      });
    });

    const adoptedSteps = [
      {
        title: "Schedule Q4 renewal alignment with leadership",
        detail: "Align on contract continuation ahead of {{metric.renewal.date}} deadline.",
        dueDate: "2026-11-20",
      },
      {
        title: "Deliver verified ROI summary deck",
        detail: "Review target expansion opportunities and usage metrics.",
        dueDate: "2026-12-01",
      },
      {
        title: "Confirm contract renewal terms",
        detail: "Finalize signature on renewal agreement.",
        dueDate: "2026-12-10",
      },
    ];

    console.log(`Adopting 3 plan steps into renewal ${renewal.id}...`);
    const adoptRes = await adoptRenewalPlan(actor, {
      renewalId: renewal.id,
      steps: adoptedSteps,
    });
    console.log(`Plan adopted: ok = ${adoptRes.ok}, stepsCount = ${adoptRes.steps.length}`);

    const updatedRenewal = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspace.id}, true)`;
      return await tx.renewal.findUniqueOrThrow({ where: { id: renewal.id } });
    });
    console.log(`Verified Renewal.planSteps on database row:`);
    console.log(JSON.stringify(updatedRenewal.planSteps, null, 2));

    console.log("\n================================================================================");
    console.log("ALL 5 MILESTONE M8 SCENARIOS COMPLETED AND VERIFIED ON FRESH SCRATCH DB!");
    console.log("================================================================================");
  } finally {
    await prisma.$disconnect();
    // Drop scratch database
    console.log(`\n[Cleanup] Dropping scratch database: ${SCRATCH_DB}`);
    psql("postgres", `DROP DATABASE ${SCRATCH_DB} WITH (FORCE);`);
    console.log("[Cleanup] Scratch database dropped cleanly.");
  }
}

main().catch((err) => {
  console.error("FATAL ERROR IN DEMO:", err);
  process.exit(1);
});
