import { createHmac, randomUUID } from "node:crypto";
import type { Role, BookScope } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { approve } from "@/modules/approvals/service";
import { sealCredentials } from "../../../credentials";
import { handleSlackInteraction, SENSITIVE_DECISIONS_FROM_SLACK } from "../../../slack/service";

/**
 * M5 §5 interactivity.int.test (Q-31, M5 rule 6): a bad signature or stale timestamp is refused;
 * an unmapped Slack user, a mapped Viewer and a mapped CSM outside the account's book are refused;
 * a mapped CSM in book approves (decidedById, via SLACK, AuditLog); a sensitive decision attempt
 * from Slack is refused at every layer and the Q-31 flag stays off; an ambiguous Slack team
 * resolves to neither workspace.
 */
const SECRET = "slack-signing-secret-test-only";
const RUN = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
const TEAM = `T${RUN}`;

type W = Awaited<ReturnType<typeof setup>>;
let W1: W;

async function member(ws: string, label: string, role: Role, bookScope: BookScope) {
  const user = await rawDb.user.create({
    data: { email: `${label}-${RUN.toLowerCase()}@larkspur.test`, name: label },
  });
  const m = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, true)`;
    return tx.membership.create({ data: { workspaceId: ws, userId: user.id, role, bookScope } });
  });
  return { ...m, userId: user.id };
}

async function setup(label: string, team: string) {
  const { actor } = await createTestAdmin(label);
  const ws = actor.workspaceId;
  const db = scopedDb(actor);
  const integration = await db.integration.create({
    data: {
      workspaceId: ws,
      provider: "SLACK",
      externalAccountId: team,
      credentialsEnc: sealCredentials({ accessToken: "fixture-slack-bot-token" }),
    },
  });
  const csm = await member(ws, `${label}-csm`, "CSM", "OWN");
  const other = await member(ws, `${label}-other`, "CSM", "OWN");
  const viewer = await member(ws, `${label}-viewer`, "VIEWER", "ALL");
  const account = await db.account.create({
    data: { workspaceId: ws, name: `${label} Co`, tier: "LONG_TAIL", ownerMembershipId: csm.id },
  });
  for (const [slackUserId, m] of [
    ["U_CSM", csm],
    ["U_OTHER", other],
    ["U_VIEWER", viewer],
  ] as const)
    await db.slackUserLink.create({
      data: {
        workspaceId: ws,
        integrationId: integration.id,
        slackUserId,
        membershipId: m.id,
        email: `${slackUserId}@x.test`,
      },
    });
  const pending = (isSensitive: boolean) =>
    db.approval.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        kind: "CREATE_TASK",
        reason: isSensitive ? "Reply about cancelling" : "Create a follow-up task",
        requiredLevel: "DRAFT_FOR_APPROVAL",
        assigneeId: csm.id,
        isSensitive,
        sensitiveReasons: isSensitive ? ["cancel"] : [],
        proof: [{ sourceType: "Account", sourceId: account.id }],
      },
    });
  return { actor, db, integration, csm, other, viewer, account, pending };
}

function request(
  team: string,
  user: string,
  actionId: string,
  approvalId: string,
  opts: { ts?: number; secret?: string } = {},
) {
  const payload = JSON.stringify({
    type: "block_actions",
    team: { id: team },
    user: { id: user },
    actions: [{ action_id: actionId, value: approvalId }],
  });
  const rawBody = `payload=${encodeURIComponent(payload)}`;
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", opts.secret ?? SECRET)
    .update(`v0:${ts}:${rawBody}`)
    .digest("hex")}`;
  return { headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig }, rawBody };
}

const text = (r: Awaited<ReturnType<typeof handleSlackInteraction>>) =>
  typeof r.body === "string" ? r.body : r.body.text;
const deps = { signingSecret: SECRET };

beforeAll(async () => {
  W1 = await setup("SlackA", TEAM);
});

describe("Slack interactivity (Q-31, M5 rule 6)", () => {
  it("refuses a bad signature and a stale timestamp, and decides nothing", async () => {
    const a = await W1.pending(false);
    expect(
      await handleSlackInteraction(
        request(TEAM, "U_CSM", "approval.approve", a.id, { secret: "wrong" }),
        deps,
      ),
    ).toEqual({
      status: 401,
      body: "unverified",
    });
    const stale = request(TEAM, "U_CSM", "approval.approve", a.id, {
      ts: Math.floor(Date.now() / 1000) - 400,
    });
    expect((await handleSlackInteraction(stale, deps)).status).toBe(401);
    expect(
      (await handleSlackInteraction(request(TEAM, "U_CSM", "approval.approve", a.id), {})).status,
    ).toBe(401); // no secret configured in test env
    expect((await W1.db.approval.findUniqueOrThrow({ where: { id: a.id } })).status).toBe(
      "PENDING",
    );
  });

  it("refuses an unmapped Slack user, a Viewer, and a CSM outside the account's book", async () => {
    const a = await W1.pending(false);
    expect(
      text(
        await handleSlackInteraction(request(TEAM, "U_STRANGER", "approval.approve", a.id), deps),
      ),
    ).toMatch(/not linked to a NexaWorks member/);
    expect(
      text(await handleSlackInteraction(request(TEAM, "U_VIEWER", "approval.approve", a.id), deps)),
    ).toBe("Your role cannot decide approvals.");
    expect(
      text(await handleSlackInteraction(request(TEAM, "U_OTHER", "approval.approve", a.id), deps)),
    ).toBe("That approval is not in your book, so nothing was decided.");
    expect((await W1.db.approval.findUniqueOrThrow({ where: { id: a.id } })).status).toBe(
      "PENDING",
    );
  });

  it("a mapped CSM in book approves a non-sensitive item: decidedById, via SLACK, audited", async () => {
    const a = await W1.pending(false);
    const r = await handleSlackInteraction(request(TEAM, "U_CSM", "approval.approve", a.id), deps);
    expect(r.status).toBe(200);
    expect(text(r)).toMatch(/^Approved\./);
    const after = await W1.db.approval.findUniqueOrThrow({ where: { id: a.id } });
    expect(after).toMatchObject({
      status: "APPROVED",
      decidedById: W1.csm.id,
      decidedVia: "SLACK",
    });
    const audit = await W1.db.auditLog.findFirstOrThrow({
      where: { action: "approval.approved", targetId: a.id },
    });
    expect(audit).toMatchObject({ actorId: W1.csm.userId });
    expect(audit.after).toMatchObject({ via: "SLACK" });
  });

  it("rejects from Slack with a note", async () => {
    const a = await W1.pending(false);
    expect(
      text(await handleSlackInteraction(request(TEAM, "U_CSM", "approval.reject", a.id), deps)),
    ).toBe("Rejected.");
    expect(await W1.db.approval.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: "REJECTED",
      decidedVia: "SLACK",
      decisionNote: "Rejected from Slack.",
    });
  });

  it("a sensitive decision attempt from Slack is REFUSED at every layer; the Q-31 flag stays off", async () => {
    expect(SENSITIVE_DECISIONS_FROM_SLACK).toBe(false);
    const a = await W1.pending(true);
    for (const action of ["approval.approve", "approval.reject"]) {
      const r = await handleSlackInteraction(request(TEAM, "U_CSM", action, a.id), deps);
      expect(text(r)).toMatch(
        /sensitive, so it is decided in the app only\. Open in app to review: .*\/approvals\//,
      );
    }
    expect(await W1.db.approval.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: "PENDING",
      decidedVia: null,
    });
    expect(
      await W1.db.auditLog.count({ where: { action: "approval.slack_refused", targetId: a.id } }),
    ).toBe(2);
    // The approvals lifecycle refuses it too, and the database CHECK refuses a direct write.
    const csmActor = {
      workspaceId: W1.actor.workspaceId,
      userId: W1.csm.userId,
      membershipId: W1.csm.id,
      role: "CSM" as const,
      canViewRevenue: false,
      bookScope: "OWN" as const,
    };
    await expect(approve(csmActor, { approvalId: a.id }, { via: "SLACK" })).rejects.toThrow(
      /never from Slack/,
    );
    await expect(
      W1.db.approval.update({
        where: { id: a.id },
        data: {
          status: "APPROVED",
          decidedVia: "SLACK",
          decidedById: W1.csm.id,
          decidedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/approval_sensitive_not_slack/);
  });

  it("an ambiguous Slack team (connected in two workspaces) resolves to neither: nothing is decided", async () => {
    const team = `T${RUN}DUP`;
    const X = await setup("SlackDupA", team);
    const Y = await setup("SlackDupB", team);
    const ax = await X.pending(false);
    const ay = await Y.pending(false);
    for (const id of [ax.id, ay.id])
      expect(
        text(await handleSlackInteraction(request(team, "U_CSM", "approval.approve", id), deps)),
      ).toBe(
        "This Slack workspace is not connected to exactly one NexaWorks workspace, so nothing was decided.",
      );
    expect((await X.db.approval.findUniqueOrThrow({ where: { id: ax.id } })).status).toBe(
      "PENDING",
    );
    expect((await Y.db.approval.findUniqueOrThrow({ where: { id: ay.id } })).status).toBe(
      "PENDING",
    );
  });

  it("a Slack click cannot decide another workspace's approval through this team", async () => {
    const B = await setup("SlackOther", `T${RUN}B`);
    const foreign = await B.pending(false);
    expect(
      text(
        await handleSlackInteraction(request(TEAM, "U_CSM", "approval.approve", foreign.id), deps),
      ),
    ).toBe("That approval is not in your book, so nothing was decided.");
    expect((await B.db.approval.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe(
      "PENDING",
    );
  });
});
