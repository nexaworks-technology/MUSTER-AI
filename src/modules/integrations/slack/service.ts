import { Prisma, type IntegrationProvider, type NotificationType } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import { ForbiddenError, requirePermission } from "@/lib/auth/permissions";
import { env } from "@/lib/config/env";
import { businessClock, localDate, realClock, type Clock } from "@/lib/dates";
import { findSlackIntegrationByTeam } from "@/lib/db/inbound";
import { scopedDb, type TenantContext } from "@/lib/db/scoped";
import { logger } from "@/lib/logger";
import type { Actor } from "@/modules/accounts/service";
import {
  approve,
  ApprovalNotFoundError,
  ApprovalStateError,
  reject,
} from "@/modules/approvals/service";
import type { IntegrationAdapter } from "../adapter";
import { slackApi, usersPage, verifySlackSignature } from "../adapters/slack";
import { loadConnection } from "../connection";
import { transportFor, type HttpTransport } from "../transport";
import { deliveryFor, type SlackDelivery, type SlackMessage } from "./delivery";
import { PRODUCT_NAME } from "@/config/product";

/**
 * Slack for the team (spec §6J3, M5 §2, founder D4, Q-31).
 *
 *  - Members are linked to Slack users by **verified** email only (Slack's is_email_confirmed).
 *  - Approval requests, big signals and a morning digest go to each linked member as a DM. Each
 *    delivery is a Notification row (channel SLACK), inserted once per recipient and thing (DB
 *    unique index), so a retry never posts twice.
 *  - Approve/Reject from Slack acts as the linked member through the same approvals service as
 *    the web UI: `approvals:decide`, book scope, and `via: "SLACK"`. Sensitive approvals show
 *    "Open in app to review" with no buttons, and a sensitive decision attempted from Slack is
 *    refused here, again in the approvals lifecycle, and by the database CHECK.
 */

/** Q-31: sensitive approvals are never decided from Slack. Founder decision; do not flip. */
export const SENSITIVE_DECISIONS_FROM_SLACK = false as const;

export interface SlackDeps {
  clock?: Clock;
  transport?: (provider: IntegrationProvider) => HttpTransport;
  adapter?: (provider: IntegrationProvider) => IntegrationAdapter<unknown>;
  delivery?: SlackDelivery;
  signingSecret?: string;
}

const appLink = (path: string) => `${env().APP_URL}${path}`;

/** The workspace's connected Slack, its bot token and a delivery, or null when not connected. */
async function slackFor(ctx: TenantContext, deps: SlackDeps) {
  const row = await scopedDb(ctx).integration.findUnique({
    where: { workspaceId_provider: { workspaceId: ctx.workspaceId, provider: "SLACK" } },
    select: { id: true, status: true },
  });
  if (!row || row.status !== "CONNECTED") return null;
  const { context } = await loadConnection(ctx, row.id, deps);
  const transport = () => (deps.transport ?? transportFor)("SLACK");
  return {
    integrationId: row.id,
    token: context.credentials.accessToken,
    transport,
    delivery: deps.delivery ?? deliveryFor(transport),
  };
}

// ─── Linking members ─────────────────────────────────────────────────────────

/** Links Slack users to active members whose email matches a verified Slack email. */
export async function linkSlackMembers(ctx: TenantContext, deps: SlackDeps = {}) {
  const slack = await slackFor(ctx, deps);
  if (!slack) return { linked: 0, unmatched: 0, notConnected: true as const };
  const db = scopedDb(ctx);
  const members = await db.membership.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, user: { select: { email: true } } },
  });
  const byEmail = new Map(members.map((m) => [m.user.email.toLowerCase(), m.id]));
  const links: Array<{ slackUserId: string; membershipId: string; email: string }> = [];
  let unmatched = 0;
  let cursor: string | undefined;
  do {
    const page = await slackApi(
      slack.transport(),
      slack.token,
      "users.list",
      { limit: 200, ...(cursor ? { cursor } : {}) },
      usersPage,
    );
    for (const u of page.members) {
      if (u.deleted || u.is_bot || u.id === "USLACKBOT") continue;
      const email = u.profile?.email?.toLowerCase();
      const member = email && u.is_email_confirmed ? byEmail.get(email) : undefined;
      if (member && email) links.push({ slackUserId: u.id, membershipId: member, email });
      else unmatched++;
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  await db.$tenantTransaction(async (tx) => {
    // Rebuilt from Slack each time: a member whose email stopped matching loses the link.
    await tx.slackUserLink.deleteMany({ where: { integrationId: slack.integrationId } });
    if (links.length)
      await tx.slackUserLink.createMany({
        data: links.map((l) => ({
          workspaceId: ctx.workspaceId,
          integrationId: slack.integrationId,
          ...l,
        })),
      });
  });
  return { linked: links.length, unmatched, notConnected: false as const };
}

// ─── Deliveries ──────────────────────────────────────────────────────────────

/**
 * Records the delivery first (once, by the unique index) and posts only if this call inserted it.
 * If the post fails the record is removed so a retry can deliver.
 */
async function deliverOnce(
  ctx: TenantContext,
  slack: NonNullable<Awaited<ReturnType<typeof slackFor>>>,
  n: {
    recipientMembershipId: string;
    slackUserId: string;
    type: NotificationType;
    refType: string;
    refId: string;
    accountId?: string;
    title: string;
  },
  message: Omit<SlackMessage, "channel">,
): Promise<boolean> {
  const db = scopedDb(ctx);
  const { count } = await db.notification.createMany({
    data: [
      {
        workspaceId: ctx.workspaceId,
        recipientMembershipId: n.recipientMembershipId,
        type: n.type,
        title: n.title.slice(0, 200),
        refType: n.refType,
        refId: n.refId,
        accountId: n.accountId ?? null,
        channel: "SLACK",
      },
    ],
    skipDuplicates: true,
  });
  if (count === 0) return false;
  try {
    await slack.delivery.post(ctx.workspaceId, { channel: n.slackUserId, ...message }, slack.token);
    return true;
  } catch (err) {
    await db.notification.deleteMany({
      where: {
        channel: "SLACK",
        recipientMembershipId: n.recipientMembershipId,
        type: n.type,
        refType: n.refType,
        refId: n.refId,
      },
    });
    throw err;
  }
}

async function linkFor(ctx: TenantContext, integrationId: string, membershipId: string | null) {
  if (!membershipId) return null;
  return scopedDb(ctx).slackUserLink.findFirst({ where: { integrationId, membershipId } });
}

export const approvalRequestedPayload = z.object({
  workspaceId: z.string().min(1),
  approvalId: z.string().min(1),
});

/** Outbox `approval.requested` → a DM to the assignee. Sensitive ones carry no buttons (Q-31). */
export async function notifyApprovalRequested(raw: unknown, deps: SlackDeps = {}) {
  const { workspaceId, approvalId } = approvalRequestedPayload.parse(raw);
  const ctx = { workspaceId };
  const slack = await slackFor(ctx, deps);
  if (!slack) return { posted: false, reason: "slack not connected" };
  const a = await scopedDb(ctx).approval.findUnique({
    where: { id: approvalId },
    include: { account: { select: { name: true } } },
  });
  if (!a || a.status !== "PENDING") return { posted: false, reason: "not pending" };
  const link = await linkFor(ctx, slack.integrationId, a.assigneeId);
  if (!link) return { posted: false, reason: "assignee not linked to Slack" };
  const url = appLink(`/approvals/${a.id}`);
  const header = `*Approval waiting:* ${a.reason}${a.account ? ` (${a.account.name})` : ""}`;
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: header } }];
  if (a.isSensitive || SENSITIVE_DECISIONS_FROM_SLACK !== false)
    blocks.push(
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Sensitive (${a.sensitiveReasons.join(", ") || "sensitive topic"}): decided in the app only.`,
          },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open in app to review" },
            url,
            action_id: "approval.open",
          },
        ],
      },
    );
  else
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          action_id: "approval.approve",
          value: a.id,
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "Reject" },
          action_id: "approval.reject",
          value: a.id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Open in app" },
          url,
          action_id: "approval.open",
        },
      ],
    });
  const posted = await deliverOnce(
    ctx,
    slack,
    {
      recipientMembershipId: link.membershipId,
      slackUserId: link.slackUserId,
      type: "APPROVAL_ASSIGNED",
      refType: "Approval",
      refId: a.id,
      accountId: a.accountId ?? undefined,
      title: `Approval waiting: ${a.reason}`,
    },
    { text: `Approval waiting: ${a.reason}${a.account ? ` (${a.account.name})` : ""}`, blocks },
  );
  return { posted, reason: posted ? "posted" : "already posted" };
}

/** Big signals just opened (real time) → a DM to each account owner. */
export async function notifySignalsOpened(
  ctx: TenantContext,
  signalIds: string[],
  deps: SlackDeps = {},
) {
  if (signalIds.length === 0) return 0;
  const slack = await slackFor(ctx, deps);
  if (!slack) return 0;
  const signals = await scopedDb(ctx).signal.findMany({
    where: { id: { in: signalIds }, status: "OPEN", severity: { in: ["WARN", "CRITICAL"] } },
    include: { account: { select: { name: true, ownerMembershipId: true } } },
  });
  let posted = 0;
  for (const s of signals) {
    const link = await linkFor(ctx, slack.integrationId, s.account.ownerMembershipId);
    if (!link) continue;
    const text = `*${s.title}* — ${s.account.name}\n${s.explanation}`;
    if (
      await deliverOnce(
        ctx,
        slack,
        {
          recipientMembershipId: link.membershipId,
          slackUserId: link.slackUserId,
          type: "SIGNAL_OPENED",
          refType: "Signal",
          refId: s.id,
          accountId: s.accountId,
          title: s.title,
        },
        {
          text: `${s.title} — ${s.account.name}`,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text } },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Open account" },
                  url: appLink(`/accounts/${s.accountId}`),
                  action_id: "signal.open",
                },
              ],
            },
          ],
        },
      )
    )
      posted++;
  }
  return posted;
}

const DIGEST_LOCAL_HOUR = 7;

/**
 * The morning digest (D-95): run after each Today rebuild; sends once per member per business
 * date, from 07:00 in the workspace's time zone. What is in Today and waiting for approval, by
 * title only, with a link back.
 */
export async function sendDigestIfDue(
  ctx: TenantContext & { timezone: string },
  deps: SlackDeps = {},
) {
  const clock = deps.clock ?? businessClock;
  const now = clock();
  const localHour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: ctx.timezone,
    }).format(now),
  );
  if (localHour < DIGEST_LOCAL_HOUR) return { sent: 0, reason: "before 07:00" };
  const slack = await slackFor(ctx, deps);
  if (!slack) return { sent: 0, reason: "slack not connected" };
  const day = localDate(now, ctx.timezone);
  const db = scopedDb(ctx);
  const links = await db.slackUserLink.findMany({ where: { integrationId: slack.integrationId } });
  let sent = 0;
  for (const link of links) {
    const [items, approvals] = await Promise.all([
      db.todayItem.findMany({
        where: { membershipId: link.membershipId },
        orderBy: { rankScore: "desc" },
        take: 3,
        select: { title: true },
      }),
      db.approval.count({ where: { status: "PENDING", assigneeId: link.membershipId } }),
    ]);
    const total = await db.todayItem.count({ where: { membershipId: link.membershipId } });
    const lines = [
      `*Your day (${day})*: ${total} item${total === 1 ? "" : "s"} in Today, ${approvals} approval${approvals === 1 ? "" : "s"} waiting.`,
      ...items.map((i) => `• ${i.title}`),
    ];
    if (
      await deliverOnce(
        ctx,
        slack,
        {
          recipientMembershipId: link.membershipId,
          slackUserId: link.slackUserId,
          type: "DAILY_DIGEST",
          refType: "Digest",
          refId: day,
          title: `Digest ${day}`,
        },
        {
          text: lines[0]!.replaceAll("*", ""),
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Open Today" },
                  url: appLink("/today"),
                  action_id: "today.open",
                },
              ],
            },
          ],
        },
      )
    )
      sent++;
  }
  return { sent, reason: "due" };
}

/** Slack's control characters, so text written by a model can never become a link or a mention. */
const slackText = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The weekly leader digest (M11 S7): a DM to each given leader who is linked to Slack, once per
 * recipient and digest run (DB unique index). The caller passes only internal leaders and text
 * that came from a SUCCEEDED, validated Leader Reporter run with no money in it; nothing here
 * ever goes to a customer. Returns how many DMs were posted.
 */
export async function sendLeaderDigest(
  ctx: TenantContext,
  digest: { runId: string; weekStart: string; lines: string[]; recipientMembershipIds: string[] },
  deps: SlackDeps = {},
): Promise<{ sent: number; reason: "sent" | "slack not connected" }> {
  const slack = await slackFor(ctx, deps);
  if (!slack) return { sent: 0, reason: "slack not connected" };
  const links = await scopedDb(ctx).slackUserLink.findMany({
    where: {
      integrationId: slack.integrationId,
      membershipId: { in: digest.recipientMembershipIds },
    },
  });
  const heading = `*Weekly digest: week of ${digest.weekStart}*`;
  const body = [heading, ...digest.lines.map((l) => `• ${slackText(l)}`)].join("\n");
  let sent = 0;
  for (const link of links) {
    if (
      await deliverOnce(
        ctx,
        slack,
        {
          recipientMembershipId: link.membershipId,
          slackUserId: link.slackUserId,
          type: "LEADER_DIGEST",
          refType: "ReportDigest",
          refId: digest.runId,
          title: `Weekly digest, week of ${digest.weekStart}`,
        },
        {
          text: `Weekly digest: week of ${digest.weekStart}`,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: body.slice(0, 2900) } },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Open the digest" },
                  url: appLink("/reports/digest"),
                  action_id: "digest.open",
                },
              ],
            },
          ],
        },
      )
    )
      sent++;
  }
  return { sent, reason: "sent" };
}

// ─── Interactivity (Approve / Reject from Slack) ─────────────────────────────

const interaction = z.object({
  type: z.literal("block_actions"),
  team: z.object({ id: z.string() }),
  user: z.object({ id: z.string() }),
  actions: z.array(z.object({ action_id: z.string(), value: z.string().optional() })).min(1),
});

export interface SlackReply {
  status: 200 | 401;
  body: { response_type: "ephemeral"; replace_original: false; text: string } | string;
}

const reply = (text: string): SlackReply => ({
  status: 200,
  body: { response_type: "ephemeral", replace_original: false, text },
});

/**
 * POST /api/integrations/slack/interactivity. Unverified (bad signature, stale timestamp, no
 * signing secret) → 401 and nothing done. Everything else answers the clicking user privately.
 */
export async function handleSlackInteraction(
  req: { headers: Record<string, string>; rawBody: string },
  deps: SlackDeps = {},
): Promise<SlackReply> {
  const secret = deps.signingSecret ?? env().SLACK_SIGNING_SECRET;
  const now = realClock();
  if (
    !secret ||
    !verifySlackSignature(
      req.rawBody,
      req.headers["x-slack-request-timestamp"],
      req.headers["x-slack-signature"],
      secret,
      now,
    )
  ) {
    logger.warn({ reason: "signature" }, "slack interaction refused");
    return { status: 401, body: "unverified" };
  }
  let parsed: z.infer<typeof interaction>;
  try {
    parsed = interaction.parse(JSON.parse(new URLSearchParams(req.rawBody).get("payload") ?? ""));
  } catch {
    return reply(`That action is not one ${PRODUCT_NAME} understands.`);
  }
  const action = parsed.actions[0]!;
  if (action.action_id !== "approval.approve" && action.action_id !== "approval.reject")
    return reply("Opening it in the app.");
  const integration = await findSlackIntegrationByTeam(parsed.team.id);
  if (!integration)
    return reply(
      `This Slack workspace is not connected to exactly one ${PRODUCT_NAME} workspace, so nothing was decided.`,
    );
  const ctx = { workspaceId: integration.workspaceId };
  const db = scopedDb(ctx);
  const link = await db.slackUserLink.findFirst({
    where: { integrationId: integration.id, slackUserId: parsed.user.id },
  });
  const member = link
    ? await db.membership.findFirst({
        where: { id: link.membershipId, status: "ACTIVE" },
        include: { user: { select: { id: true } } },
      })
    : null;
  if (!member)
    return reply(
      `Your Slack account is not linked to a ${PRODUCT_NAME} member (we match verified email addresses), so nothing was decided.`,
    );
  const actor: Actor = {
    workspaceId: ctx.workspaceId,
    userId: member.user.id,
    membershipId: member.id,
    role: member.role,
    canViewRevenue: member.canViewRevenue,
    bookScope: member.bookScope,
  };
  const approvalId = z.string().min(1).max(60).safeParse(action.value);
  if (!approvalId.success) return reply("That button is missing its approval.");
  const link2app = appLink(`/approvals/${approvalId.data}`);
  try {
    requirePermission(actor, "approvals:decide");
    const pending = await db.approval.findUnique({
      where: { id: approvalId.data },
      select: { isSensitive: true },
    });
    if (pending?.isSensitive && !SENSITIVE_DECISIONS_FROM_SLACK) {
      await writeAudit({
        workspaceId: ctx.workspaceId,
        actorType: "USER",
        actorId: actor.userId,
        action: "approval.slack_refused",
        targetType: "Approval",
        targetId: approvalId.data,
        summary:
          "A sensitive approval was not decided from Slack (Q-31); it must be reviewed in the app",
      });
      return reply(
        `This one is sensitive, so it is decided in the app only. Open in app to review: ${link2app}`,
      );
    }
    if (action.action_id === "approval.approve") {
      const r = await approve(actor, { approvalId: approvalId.data }, { via: "SLACK" });
      return reply(
        `Approved.${r.send && "status" in r.send ? ` Email: ${r.send.status.toLowerCase().replaceAll("_", " ")}.` : ""}`,
      );
    }
    await reject(
      actor,
      { approvalId: approvalId.data, note: "Rejected from Slack." },
      { via: "SLACK" },
    );
    return reply("Rejected.");
  } catch (err) {
    if (err instanceof ForbiddenError) return reply("Your role cannot decide approvals.");
    if (err instanceof ApprovalNotFoundError)
      return reply("That approval is not in your book, so nothing was decided.");
    if (err instanceof ApprovalStateError) return reply(`${err.message} ${link2app}`);
    if (
      err instanceof Prisma.PrismaClientKnownRequestError ||
      err instanceof Prisma.PrismaClientUnknownRequestError
    ) {
      logger.warn(
        { workspaceId: ctx.workspaceId, approvalId: approvalId.data },
        "slack decision refused by the database",
      );
      return reply(`Nothing was decided. Open in app to review: ${link2app}`);
    }
    throw err;
  }
}
