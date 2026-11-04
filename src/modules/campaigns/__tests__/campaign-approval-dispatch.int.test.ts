import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { approve } from "@/modules/approvals/service";
import { renderCampaignText } from "@/modules/campaigns/service";
import { dispatch, DispatchRefusedError } from "@/modules/outbound/service";
import { createTestAdmin } from "@/test/fixtures";

const clock = () => new Date("2026-11-03T15:00:00Z");

function fakeTransport() {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  return {
    sent,
    transport: {
      name: "log" as const,
      async send(m: { to: string; subject: string; text: string }) {
        sent.push(m);
        return { id: `fake-${sent.length}` };
      },
    },
  };
}

let db: ScopedDb;
let ws: string;
let admin: Actor;
let leader: Actor;
let csm: Actor;
let accountId: string;
let contactId: string;
let segmentId: string;

beforeAll(async () => {
  ({ actor: admin } = await createTestAdmin("Campaigns"));
  ws = admin.workspaceId;
  db = scopedDb(admin);

  const leaderUser = await rawDb.user.create({
    data: { email: `leader-${randomUUID()}@t.test`, name: "Leader" },
  });
  const leaderMem = await db.membership.create({
    data: { workspaceId: ws, userId: leaderUser.id, role: "CS_LEADER" },
  });
  leader = {
    workspaceId: ws,
    userId: leaderUser.id,
    membershipId: leaderMem.id,
    role: "CS_LEADER",
    canViewRevenue: true,
    bookScope: "ALL",
  };

  const csmUser = await rawDb.user.create({
    data: { email: `csm-${randomUUID()}@t.test`, name: "CSM" },
  });
  const csmMem = await db.membership.create({
    data: { workspaceId: ws, userId: csmUser.id, role: "CSM", bookScope: "ALL" },
  });
  csm = {
    workspaceId: ws,
    userId: csmUser.id,
    membershipId: csmMem.id,
    role: "CSM",
    canViewRevenue: false,
    bookScope: "ALL",
  };

  const acct = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Acme Corp",
      tier: "MID_TOUCH",
      timezone: "America/New_York",
    },
  });
  accountId = acct.id;

  const contact = await db.contact.create({
    data: {
      workspaceId: ws,
      accountId,
      name: "Alice Smith",
      email: `alice-${randomUUID()}@example.com`,
      status: "ACTIVE",
    },
  });
  contactId = contact.id;

  const seg = await db.segment.create({
    data: {
      workspaceId: ws,
      name: "Mid Touch Customers",
      filter: { tier: { in: ["MID_TOUCH"] } },
    },
  });
  segmentId = seg.id;
});

describe("S13 Campaign Schema, Approvals, and Dispatch Mode", () => {
  describe("DB Check: approval_campaign_account_null", () => {
    it("allows accountId: null when kind is CAMPAIGN", async () => {
      const app = await db.approval.create({
        data: {
          workspaceId: ws,
          accountId: null,
          kind: "CAMPAIGN",
          reason: "Q4 Outreach Campaign",
          requiredLevel: "DRAFT_FOR_APPROVAL",
        },
      });
      expect(app.id).toBeDefined();
      expect(app.accountId).toBeNull();
      expect(app.kind).toBe("CAMPAIGN");
    });

    it("rejects accountId: null when kind is not CAMPAIGN", async () => {
      await expect(
        db.approval.create({
          data: {
            workspaceId: ws,
            accountId: null,
            kind: "SEND_EMAIL",
            reason: "Individual email missing account",
            requiredLevel: "DRAFT_FOR_APPROVAL",
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("Campaign Approval Decision Rights", () => {
    it("CSM cannot decide a campaign approval", async () => {
      const app = await db.approval.create({
        data: {
          workspaceId: ws,
          accountId: null,
          kind: "CAMPAIGN",
          reason: "Product Update",
          requiredLevel: "DRAFT_FOR_APPROVAL",
        },
      });

      await expect(approve(csm, { approvalId: app.id }, { clock })).rejects.toThrow(
        ForbiddenError,
      );
      await expect(approve(csm, { approvalId: app.id }, { clock })).rejects.toThrow(
        "Only an Admin or CS Leader may decide a campaign approval",
      );
    });

    it("CS Leader can approve a campaign approval", async () => {
      const app = await db.approval.create({
        data: {
          workspaceId: ws,
          accountId: null,
          kind: "CAMPAIGN",
          reason: "Product Update for Leader",
          requiredLevel: "DRAFT_FOR_APPROVAL",
        },
      });

      const res = await approve(leader, { approvalId: app.id }, { clock });
      expect(res.approval.status).toBe("APPROVED");
      expect(res.approval.decidedById).toBe(leader.membershipId);
    });
  });

  describe("Dispatch Campaign Mode", () => {
    async function createTestCampaign(opts?: { approvedBy?: Actor }) {
      const decider = opts?.approvedBy ?? admin;
      const app = await db.approval.create({
        data: {
          workspaceId: ws,
          accountId: null,
          kind: "CAMPAIGN",
          reason: "Feature Announcement",
          requiredLevel: "DRAFT_FOR_APPROVAL",
        },
      });
      await approve(decider, { approvalId: app.id }, { clock });

      const campaign = await db.campaign.create({
        data: {
          workspaceId: ws,
          name: "Feature Launch",
          segmentId,
          subject: "Exciting update for {{account.name}}",
          body: "Hi {{contact.first_name}}, check out our new features!",
          status: "SCHEDULED",
          approvalId: app.id,
        },
      });

      return { campaign, approval: app };
    }

    it("sends campaign email when approved by Admin/CS Leader with rendered text", async () => {
      const { campaign } = await createTestCampaign();
      const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
      const contact = await db.contact.findUniqueOrThrow({ where: { id: contactId } });

      const subject = renderCampaignText(campaign.subject, { account, contact });
      const bodyText = renderCampaignText(campaign.body, { account, contact });

      const msg = await db.outboundMessage.create({
        data: {
          workspaceId: ws,
          accountId,
          contactId,
          toEmail: contact.email!,
          campaignId: campaign.id,
          sendMode: "CAMPAIGN",
          subject,
          bodyText,
          status: "AWAITING_APPROVAL",
        },
      });

      const recip = await db.campaignRecipient.create({
        data: {
          workspaceId: ws,
          campaignId: campaign.id,
          contactId,
          accountId,
          outboundMessageId: msg.id,
          status: "QUEUED",
        },
      });

      const transport = fakeTransport();
      const res = await dispatch(admin, msg.id, { clock, transport: transport.transport });

      expect(res.status).toBe("SENT");
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]!.subject).toBe("Exciting update for Acme Corp");
      expect(transport.sent[0]!.text).toBe("Hi Alice, check out our new features!");

      const updatedRecip = await db.campaignRecipient.findUniqueOrThrow({ where: { id: recip.id } });
      expect(updatedRecip.status).toBe("SENT");
      expect(updatedRecip.sentAt).toBeDefined();
    });

    it("refuses dispatch when text differs from approved template", async () => {
      const { campaign } = await createTestCampaign();
      const contact = await db.contact.findUniqueOrThrow({ where: { id: contactId } });

      const msg = await db.outboundMessage.create({
        data: {
          workspaceId: ws,
          accountId,
          contactId,
          toEmail: contact.email!,
          campaignId: campaign.id,
          sendMode: "CAMPAIGN",
          subject: "Different subject entirely",
          bodyText: "Different body entirely",
          status: "AWAITING_APPROVAL",
        },
      });

      const transport = fakeTransport();
      await expect(
        dispatch(admin, msg.id, { clock, transport: transport.transport }),
      ).rejects.toThrow(DispatchRefusedError);
    });

    it("holds message when recipient guard 7 (suppressed) triggers", async () => {
      const { campaign } = await createTestCampaign();

      const supContact = await db.contact.create({
        data: {
          workspaceId: ws,
          accountId,
          name: "Suppressed User",
          email: `suppressed-${randomUUID()}@example.com`,
          status: "ACTIVE",
        },
      });

      await db.emailSuppression.create({
        data: {
          workspaceId: ws,
          email: supContact.email!,
          reason: "UNSUBSCRIBED",
        },
      });

      const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
      const subject = renderCampaignText(campaign.subject, { account, contact: supContact });
      const bodyText = renderCampaignText(campaign.body, { account, contact: supContact });

      const msg = await db.outboundMessage.create({
        data: {
          workspaceId: ws,
          accountId,
          contactId: supContact.id,
          toEmail: supContact.email!,
          campaignId: campaign.id,
          sendMode: "CAMPAIGN",
          subject,
          bodyText,
          status: "AWAITING_APPROVAL",
        },
      });

      const recip = await db.campaignRecipient.create({
        data: {
          workspaceId: ws,
          campaignId: campaign.id,
          contactId: supContact.id,
          accountId,
          outboundMessageId: msg.id,
          status: "QUEUED",
        },
      });

      const transport = fakeTransport();
      const res = await dispatch(admin, msg.id, { clock, transport: transport.transport });

      expect(res.status).toBe("HELD");
      expect(transport.sent).toHaveLength(0);

      const updatedRecip = await db.campaignRecipient.findUniqueOrThrow({ where: { id: recip.id } });
      expect(updatedRecip.status).toBe("HELD");
      expect(updatedRecip.heldReason).toContain("suppression list");
    });

    it("campaign send ignores guard 2 (account cooldown) and guard 8 (auto-send disabled)", async () => {
      const { campaign } = await createTestCampaign();

      // Recent email to account within cooldown
      await db.outboundMessage.create({
        data: {
          workspaceId: ws,
          accountId,
          contactId,
          toEmail: "previous@example.com",
          sendMode: "APPROVED",
          subject: "Recent email",
          bodyText: "Text",
          status: "SENT",
          sentAt: new Date("2026-11-03T14:30:00Z"), // 30 mins ago
          providerMessageId: "fake-provider-id",
        },
      });

      const newContact = await db.contact.create({
        data: {
          workspaceId: ws,
          accountId,
          name: "Bob Jones",
          email: `bob-${randomUUID()}@example.com`,
          status: "ACTIVE",
        },
      });

      const account = await db.account.findUniqueOrThrow({ where: { id: accountId } });
      const subject = renderCampaignText(campaign.subject, { account, contact: newContact });
      const bodyText = renderCampaignText(campaign.body, { account, contact: newContact });

      const msg = await db.outboundMessage.create({
        data: {
          workspaceId: ws,
          accountId,
          contactId: newContact.id,
          toEmail: newContact.email!,
          campaignId: campaign.id,
          sendMode: "CAMPAIGN",
          subject,
          bodyText,
          status: "AWAITING_APPROVAL",
        },
      });

      const transport = fakeTransport();
      const res = await dispatch(admin, msg.id, { clock, transport: transport.transport });

      // Should succeed because guard 2 does not block campaigns
      expect(res.status).toBe("SENT");
      expect(transport.sent).toHaveLength(1);
    });
  });
});
