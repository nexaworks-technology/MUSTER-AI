import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { listMyNotifications, unreadCount } from "@/modules/notifications/service";
import { sealCredentials } from "../../../credentials";
import { createFixtureTransport, loadFixture } from "../../../fixture-transport";
import type { SlackDelivery, SlackMessage } from "../../../slack/delivery";
import { linkSlackMembers, notifyApprovalRequested, sendDigestIfDue } from "../../../slack/service";

/**
 * Slack deliveries (founder D4, D-95): members link by verified email only; an approval request
 * is DM'd once with Approve/Reject, or with "Open in app to review" and no buttons when it is
 * sensitive; the digest goes once per business date and not before 07:00; Slack rows never show
 * in the in-app bell.
 */
async function setup(label: string) {
  const { actor } = await createTestAdmin(label);
  const ws = actor.workspaceId;
  const db = scopedDb(actor);
  const tag = `${label.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const mk = async (key: string) => {
    const user = await rawDb.user.create({
      data: { email: `${key}-${tag}@larkspur.test`, name: key },
    });
    return rawDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return tx.membership.create({
        data: { workspaceId: ws, userId: user.id, role: "CSM", bookScope: "OWN" },
      });
    });
  };
  const aisha = await mk("aisha");
  const leo = await mk("leo");
  await db.integration.create({
    data: {
      workspaceId: ws,
      provider: "SLACK",
      externalAccountId: `T${randomUUID().slice(0, 8).toUpperCase()}`,
      credentialsEnc: sealCredentials({ accessToken: "xoxb-test" }),
    },
  });
  const transport = () => {
    const t = createFixtureTransport(["auth", "users"].flatMap((f) => loadFixture("slack", f)));
    const original = t.request.bind(t);
    return Object.assign(t, {
      request: async (req: Parameters<typeof original>[0]) => {
        const res = await original(req);
        const body = JSON.stringify(res.body)
          .replaceAll("aisha@larkspur.test", `aisha-${tag}@larkspur.test`)
          .replaceAll("leo@larkspur.test", `leo-${tag}@larkspur.test`)
          .replaceAll("admin@larkspur.test", actor.user.email);
        return { ...res, body: JSON.parse(body) as unknown };
      },
    });
  };
  const posted: SlackMessage[] = [];
  const delivery: SlackDelivery = { mode: "log", post: async (_w, m) => void posted.push(m) };
  const account = await db.account.create({
    data: { workspaceId: ws, name: `${label} Co`, tier: "LONG_TAIL", ownerMembershipId: aisha.id },
  });
  return { actor, db, aisha, leo, account, posted, deps: { transport, delivery } };
}

const blocksText = (m: SlackMessage) => JSON.stringify(m.blocks);

describe("Slack deliveries", () => {
  it("links members by verified email only (unverified, bots, Slackbot and outsiders are not linked)", async () => {
    const S = await setup("SlackLink");
    expect(await linkSlackMembers(S.actor, S.deps)).toEqual({
      linked: 2,
      unmatched: 2,
      notConnected: false,
    });
    const links = await S.db.slackUserLink.findMany({ orderBy: { slackUserId: "asc" } });
    expect(links.map((l) => [l.slackUserId, l.membershipId])).toEqual([
      ["U0AISHA", S.aisha.id],
      ["U0LEO", S.leo.id],
    ]);
    // The Admin's Slack email is not verified, so the Admin is not linked.
    expect(links.some((l) => l.membershipId === S.actor.membershipId)).toBe(false);
  });

  it("an approval request is DM'd once with Approve/Reject; a sensitive one has no buttons", async () => {
    const S = await setup("SlackApproval");
    await linkSlackMembers(S.actor, S.deps);
    const make = (isSensitive: boolean) =>
      S.db.approval.create({
        data: {
          workspaceId: S.actor.workspaceId,
          accountId: S.account.id,
          kind: "CREATE_TASK",
          reason: isSensitive ? "Answer the cancellation email" : "Create a follow-up task",
          requiredLevel: "DRAFT_FOR_APPROVAL",
          assigneeId: S.aisha.id,
          isSensitive,
          sensitiveReasons: isSensitive ? ["cancel"] : [],
        },
      });
    const plain = await make(false);
    const p = { workspaceId: S.actor.workspaceId, approvalId: plain.id };
    expect(await notifyApprovalRequested(p, S.deps)).toEqual({ posted: true, reason: "posted" });
    expect(await notifyApprovalRequested(p, S.deps)).toEqual({
      posted: false,
      reason: "already posted",
    });
    expect(S.posted).toHaveLength(1);
    expect(S.posted[0]!.channel).toBe("U0AISHA");
    expect(blocksText(S.posted[0]!)).toContain('"action_id":"approval.approve"');
    expect(blocksText(S.posted[0]!)).toContain('"action_id":"approval.reject"');

    const sensitive = await make(true);
    await notifyApprovalRequested(
      { workspaceId: S.actor.workspaceId, approvalId: sensitive.id },
      S.deps,
    );
    const msg = S.posted[1]!;
    expect(blocksText(msg)).toContain("Open in app to review");
    expect(blocksText(msg)).not.toContain("approval.approve");
    expect(blocksText(msg)).not.toContain("approval.reject");

    // Slack deliveries are records, not bell items.
    const aishaActor = {
      workspaceId: S.actor.workspaceId,
      userId: "x",
      membershipId: S.aisha.id,
      role: "CSM" as const,
      canViewRevenue: false,
      bookScope: "OWN" as const,
    };
    expect(await S.db.notification.count({ where: { channel: "SLACK" } })).toBe(2);
    expect(await unreadCount(aishaActor)).toBe(0);
    expect(await listMyNotifications(aishaActor)).toEqual([]);
  });

  it("without Slack connected, nothing is posted and nothing fails", async () => {
    const { actor } = await createTestAdmin("SlackNone");
    expect(
      await notifyApprovalRequested({ workspaceId: actor.workspaceId, approvalId: "x" }),
    ).toEqual({
      posted: false,
      reason: "slack not connected",
    });
  });

  it("the digest goes once per business date, from 07:00 workspace time", async () => {
    const S = await setup("SlackDigest");
    await linkSlackMembers(S.actor, S.deps);
    await S.db.todayItem.create({
      data: {
        workspaceId: S.actor.workspaceId,
        membershipId: S.aisha.id,
        itemType: "TASK",
        refId: "t1",
        title: "Call Sundial about the failed card",
        rankScore: 1,
        rankReasons: [],
        computedAt: new Date(),
      },
    });
    const at = (iso: string) => ({ ...S.deps, clock: () => new Date(iso) });
    const ctx = { workspaceId: S.actor.workspaceId, timezone: "America/New_York" };
    expect(await sendDigestIfDue(ctx, at("2026-11-02T10:30:00Z"))).toEqual({
      sent: 0,
      reason: "before 07:00",
    }); // 05:30 NY
    expect(await sendDigestIfDue(ctx, at("2026-11-02T13:00:00Z"))).toEqual({
      sent: 2,
      reason: "due",
    });
    expect(await sendDigestIfDue(ctx, at("2026-11-02T17:00:00Z"))).toEqual({
      sent: 0,
      reason: "due",
    });
    const aisha = S.posted.find((m) => m.channel === "U0AISHA")!;
    expect(blocksText(aisha)).toContain("1 item in Today, 0 approvals waiting");
    expect(blocksText(aisha)).toContain("Call Sundial about the failed card");
    expect(await sendDigestIfDue(ctx, at("2026-11-03T13:00:00Z"))).toEqual({
      sent: 2,
      reason: "due",
    });
  });
});
