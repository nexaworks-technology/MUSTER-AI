import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createNote } from "@/modules/notes/service";
import { executeStep, processPlayNoteCreated } from "@/modules/plays/runner";
import { SEEDED_PLAYS } from "@/modules/plays/seeded/definitions";
import { getPlayResults, killPlay, publishPlay } from "@/modules/plays/service";
import { createTestAdmin } from "@/test/fixtures";

describe("S11: Play Results, Dead Play Detection & Cancellation Save noteTag (spec §2, M8)", () => {
  it("getPlayResults computes dead play status, skips with reasons, and revenue protection", async () => {
    const { workspace, actor: admin } = await createTestAdmin("PlayResultsWS");
    const db = scopedDb(admin);

    // Create a play published 40 days ago with 0 runs -> dead play NEVER_FIRED
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const play = await db.play.create({
      data: {
        workspaceId: workspace.id,
        key: "old-unused-play",
        name: "Old Unused Play",
        status: "PUBLISHED",
      },
    });
    const version = await db.playVersion.create({
      data: {
        workspaceId: workspace.id,
        playId: play.id,
        version: 1,
        definition: {
          name: "Old Unused Play",
          trigger: { type: "signal", ruleKey: "some_rule" },
          steps: [],
        } as any,
        publishedAt: fortyDaysAgo,
        publishedById: admin.membershipId,
      },
    });
    await db.play.update({
      where: { id: play.id },
      data: { currentVersionId: version.id },
    });

    const results = await getPlayResults(admin, play.id);
    expect(results.deadPlayStatus.isDead).toBe(true);
    expect(results.deadPlayStatus.reason).toBe("NEVER_FIRED");
    expect(results.stats.totalRuns).toBe(0);
    expect(results.stats.accountsEntered).toBe(0);

    // Operator executes Kill action (never auto-killed)
    await killPlay(admin, play.id);
    const afterKill = await db.play.findUniqueOrThrow({ where: { id: play.id } });
    expect(afterKill.status).toBe("KILLED");

    // After kill, dead-play check reports false because status is KILLED
    const resultsAfterKill = await getPlayResults(admin, play.id);
    expect(resultsAfterKill.play.status).toBe("KILLED");
    expect(resultsAfterKill.deadPlayStatus.isDead).toBe(false);
  });

  it("getPlayResults enumerates skips with reasons and calculates financial protection", async () => {
    const { workspace, actor: admin } = await createTestAdmin("PlaySkipsResultsWS");
    const db = scopedDb(admin);
    const account = await db.account.create({
      data: {
        workspaceId: workspace.id,
        name: "Acme Corp",
        tier: "HIGH_TOUCH",
        arrMinor: 1200000n, // $12,000 ARR
      },
    });

    const play = await db.play.create({
      data: {
        workspaceId: workspace.id,
        key: "play-with-skips",
        name: "Play With Skips",
        status: "PUBLISHED",
      },
    });
    const version = await db.playVersion.create({
      data: {
        workspaceId: workspace.id,
        playId: play.id,
        version: 1,
        definition: {
          name: "Play With Skips",
          trigger: { type: "signal", ruleKey: "some_rule" },
          steps: [
            {
              key: "capped-draft",
              name: "Outreach Email",
              handler: "draft",
              approvalLevelByTier: {
                HIGH_TOUCH: "DO_AUTOMATICALLY",
                MID_TOUCH: "DO_AUTOMATICALLY",
                LONG_TAIL: "DO_AUTOMATICALLY",
              },
              safe: true,
              sensitive: false,
            },
          ],
        } as any,
        publishedAt: new Date(),
        publishedById: admin.membershipId,
      },
    });
    await db.play.update({
      where: { id: play.id },
      data: { currentVersionId: version.id },
    });

    // Create a run with a SKIPPED step
    const run = await db.playRun.create({
      data: {
        workspaceId: workspace.id,
        playId: play.id,
        playVersionId: version.id,
        accountId: account.id,
        status: "COMPLETED",
        triggerRef: "test-trigger-1",
        enteredAt: new Date(),
      },
    });

    await db.playStepRun.create({
      data: {
        workspaceId: workspace.id,
        playRunId: run.id,
        stepKey: "capped-draft",
        handler: "draft",
        status: "SKIPPED",
        result: {
          skippedReason: "Account contacted 2 times this week (frequency cap: 2/week)",
        },
      },
    });

    const results = await getPlayResults(admin, play.id);
    expect(results.stats.totalRuns).toBe(1);
    expect(results.stats.accountsEntered).toBe(1);
    expect(results.stats.skipsCount).toBe(1);
    expect(results.skips.length).toBe(1);
    expect(results.skips[0].stepKey).toBe("capped-draft");
    expect(results.skips[0].skipReason).toContain("frequency cap: 2/week");
    expect(results.skips[0].accountName).toBe("Acme Corp");
    // Admin can view revenue -> arrMinor returned
    expect(results.stats.revenueProtectedMinor).toBe(1200000n);
  });

  it("Cancellation Save triggers on note.created with tag cancellation-risk and respects sensitive flag", async () => {
    const { workspace, actor: admin } = await createTestAdmin("CancellationSaveWS");
    const db = scopedDb(admin);
    const account = await db.account.create({
      data: {
        workspaceId: workspace.id,
        name: "Risk Account",
        tier: "HIGH_TOUCH",
      },
    });
    await db.contact.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        name: "Bob Risk",
        email: "bob@riskaccount.test",
        status: "ACTIVE",
      },
    });

    // Seed Cancellation Save play (seeded play 14)
    const cancelSeed = SEEDED_PLAYS.find((p) => p.key === "cancellation-save")!;
    expect(cancelSeed).toBeDefined();

    const play = await db.play.create({
      data: {
        workspaceId: workspace.id,
        key: cancelSeed.key,
        name: cancelSeed.name,
        description: cancelSeed.description,
        category: cancelSeed.category,
        isSeeded: true,
        status: "DRAFT",
      },
    });
    const version = await db.playVersion.create({
      data: {
        workspaceId: workspace.id,
        playId: play.id,
        version: 1,
        definition: cancelSeed.definition as any,
        safetyCheck: { passed: true, refusals: [] },
      },
    });
    await db.play.update({
      where: { id: play.id },
      data: { currentVersionId: version.id },
    });

    // Publish the play
    const pubResult = await publishPlay(admin, play.id);
    expect(pubResult.status).toBe("PUBLISHED");

    // Create note with cancellation-risk tag
    const { note } = await createNote(admin, {
      accountId: account.id,
      body: "Customer mentioned they are evaluating churn options due to price increases.",
      tags: ["cancellation-risk"],
    });

    // Process the note.created event via consumer
    const consumeRes = await processPlayNoteCreated({
      workspaceId: workspace.id,
      noteId: note.id,
      accountId: account.id,
      tags: ["cancellation-risk"],
    });

    expect(consumeRes.entered).toContain(play.id);

    // Verify PlayRun was created
    const playRun = await db.playRun.findFirstOrThrow({
      where: {
        playId: play.id,
        accountId: account.id,
        triggerRef: `note:${note.id}:cancellation-risk`,
      },
    });
    expect(playRun.status).toBe("RUNNING");

    // Execute step 1: Executive Save Review (Task)
    const step1 = await executeStep(admin, { playRunId: playRun.id, stepKey: "task-save" });
    expect(step1.status).toBe("DONE");

    // Execute step 2: Draft Save Offer (Draft - sensitive: true)
    // Rule 3 / D1: All customer steps in Cancellation Save are sensitive -> must require approval!
    const step2 = await executeStep(admin, { playRunId: playRun.id, stepKey: "draft-offer" });
    expect(step2.status).toBe("WAITING_APPROVAL");

    const approvals = await db.approval.findMany({
      where: { workspaceId: workspace.id, accountId: account.id },
    });
    expect(approvals.length).toBeGreaterThan(0);
    const draftApproval = approvals.find((a) => a.kind === "SEND_EMAIL");
    expect(draftApproval).toBeDefined();
    expect(draftApproval?.status).toBe("PENDING");
    expect(draftApproval?.isSensitive).toBe(true);
  });
});
