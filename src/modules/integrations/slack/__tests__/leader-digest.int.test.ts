import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { sealCredentials } from "../../credentials";
import { createFixtureTransport } from "../../fixture-transport";
import type { SlackDelivery, SlackMessage } from "../delivery";
import { sendLeaderDigest } from "../service";

/**
 * The weekly leader digest in Slack (M11 S7): a DM to each linked leader the caller names, once per
 * run; Slack's control characters in the text are escaped; nothing is posted without a connection.
 */
async function member(ws: string, role: "CS_LEADER" | "CSM", label: string) {
  const user = await rawDb.user.create({
    data: { email: `${label}-${randomUUID().slice(0, 8)}@larkspur.test`, name: label },
  });
  return rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, true)`;
    return tx.membership.create({ data: { workspaceId: ws, userId: user.id, role } });
  });
}

describe("sendLeaderDigest", () => {
  it("posts one DM per named, linked leader, once, with control characters escaped", async () => {
    const { actor } = await createTestAdmin("SlackDig");
    const ws = actor.workspaceId;
    const db = scopedDb(actor);
    const leader = await member(ws, "CS_LEADER", "leader");
    const csm = await member(ws, "CSM", "csm");
    const integration = await db.integration.create({
      data: {
        workspaceId: ws,
        provider: "SLACK",
        externalAccountId: `T${randomUUID().slice(0, 8).toUpperCase()}`,
        credentialsEnc: sealCredentials({ accessToken: "fixture-slack-bot-token" }),
      },
    });
    for (const [m, id] of [
      [leader.id, "U0LEADER"],
      [csm.id, "U0CSM"],
    ] as const)
      await db.slackUserLink.create({
        data: {
          workspaceId: ws,
          integrationId: integration.id,
          membershipId: m,
          slackUserId: id,
          email: `${id.toLowerCase()}@larkspur.test`,
        },
      });
    const posted: SlackMessage[] = [];
    const delivery: SlackDelivery = { mode: "log", post: async (_w, m) => void posted.push(m) };
    const deps = { delivery, transport: () => createFixtureTransport([]) };
    const digest = {
      runId: "run_1",
      weekStart: "2026-11-02",
      lines: ["At Risk now is 3 <!channel> & more."],
      // The caller names the leaders; a linked CSM who is not named gets nothing.
      recipientMembershipIds: [leader.id, actor.membershipId],
    };
    expect(await sendLeaderDigest({ workspaceId: ws }, digest, deps)).toEqual({
      sent: 1,
      reason: "sent",
    });
    expect(await sendLeaderDigest({ workspaceId: ws }, digest, deps)).toEqual({
      sent: 0,
      reason: "sent",
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.channel).toBe("U0LEADER");
    const blocks = JSON.stringify(posted[0]!.blocks);
    expect(blocks).toContain("&lt;!channel&gt; &amp; more");
    expect(blocks).not.toContain("<!channel>");
    expect(blocks).toContain("/reports/digest");
    // A Slack delivery is a record, not a bell item.
    expect(
      await db.notification.count({ where: { type: "LEADER_DIGEST", channel: "SLACK" } }),
    ).toBe(1);
  });

  it("without Slack connected nothing is posted and nothing fails", async () => {
    const { actor } = await createTestAdmin("SlackDigNone");
    expect(
      await sendLeaderDigest(
        { workspaceId: actor.workspaceId },
        { runId: "r", weekStart: "2026-11-02", lines: [], recipientMembershipIds: [] },
      ),
    ).toEqual({ sent: 0, reason: "slack not connected" });
  });
});
