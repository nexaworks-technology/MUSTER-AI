import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import {
  createFixtureTransport,
  loadFixture,
} from "../fixture-transport";
import { sealCredentials } from "../credentials";
import { ingestBatch } from "../ingest.service";
import { executeApprovedWriteBack, requestWriteBack, setWriteBack } from "../writeback.service";

describe("Email connectors integration (Gmail & Microsoft Graph)", () => {
  it("HARD PRIVACY RULE: unknown contact / unknown domain mail is discarded without being stored", async () => {
    const { actor: admin } = await createTestAdmin("email-privacy");
    const db = scopedDb(admin);

    // 1. Create known account and known contact
    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Enterprise Alpha",
        domain: "alpha.test",
        tier: "HIGH_TOUCH",
      },
    });

    const contact = await db.contact.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        name: "Alice Alpha",
        email: "alice@alpha.test",
      },
    });

    // 2. Prepare mail items:
    // Mail 1: from known contact -> MATCHED
    // Mail 2: from unknown domain & contact -> DISCARDED
    // Mail 3: from free-mail domain (gmail.com) with unknown contact -> DISCARDED
    const mailItems = [
      {
        externalId: "mail_matched_1",
        threadExternalId: "th_matched_1",
        direction: "INBOUND" as const,
        fromAddress: "alice@alpha.test",
        fromName: "Alice Alpha",
        toAddresses: ["csm@company.test"],
        subject: "Contract renewal discussion",
        bodyText: "Looking forward to renewing our contract for another year.",
        sentAt: new Date("2026-11-05T09:00:00Z"),
      },
      {
        externalId: "mail_unknown_domain",
        threadExternalId: "th_unknown_1",
        direction: "INBOUND" as const,
        fromAddress: "stranger@unknown-vendor.test",
        fromName: "Stranger",
        toAddresses: ["csm@company.test"],
        subject: "Spam / Cold outreach",
        bodyText: "Buy our lead generation software today!",
        sentAt: new Date("2026-11-05T09:30:00Z"),
      },
      {
        externalId: "mail_freemail_unmatched",
        threadExternalId: "th_freemail_1",
        direction: "INBOUND" as const,
        fromAddress: "randomperson@gmail.com",
        fromName: "Random Person",
        toAddresses: ["csm@company.test"],
        subject: "Personal question",
        bodyText: "Are you free this weekend?",
        sentAt: new Date("2026-11-05T10:00:00Z"),
      },
    ];

    const integration = await db.integration.create({
      data: {
        workspaceId: admin.workspaceId,
        provider: "GOOGLE_EMAIL",
        status: "CONNECTED",
      },
    });

    const target = {
      workspaceId: admin.workspaceId,
      integrationId: integration.id,
      source: "GMAIL" as const,
    };
    await ingestBatch(target, { kind: "mail", records: mailItems });

    // 3. Verify Privacy Rule:
    // Only mail_matched_1 should be stored.
    const messages = await db.message.findMany({
      where: { workspaceId: admin.workspaceId },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.fromAddress).toBe("alice@alpha.test");
    expect(messages[0]!.accountId).toBe(account.id);
    expect(messages[0]!.fromContactId).toBe(contact.id);

    // Unmatched mail MUST NOT be stored in UnmatchedInbound (hard privacy rule, D3)
    const unmatchedRows = await db.unmatchedInbound.findMany({
      where: { workspaceId: admin.workspaceId },
    });
    expect(unmatchedRows).toHaveLength(0);

    // Matched mail created Conversation and InboxItem
    const conversations = await db.conversation.findMany({
      where: { workspaceId: admin.workspaceId },
    });
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.accountId).toBe(account.id);

    const inboxItems = await db.inboxItem.findMany({
      where: { workspaceId: admin.workspaceId },
    });
    expect(inboxItems).toHaveLength(1);
    expect(inboxItems[0]!.sourceId).toBe(messages[0]!.id);
    expect(inboxItems[0]!.matchedBy).toBe("CONTACT_EMAIL");
  });

  it("sync-twice proof: second sync changes nothing", async () => {
    const { actor: admin } = await createTestAdmin("email-synctwice");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Acme Corp",
        domain: "acme.test",
        tier: "HIGH_TOUCH",
      },
    });

    await db.contact.create({
      data: {
        workspaceId: admin.workspaceId,
        accountId: account.id,
        name: "Bob Acme",
        email: "bob@acme.test",
      },
    });

    const mailBatch = [
      {
        externalId: "mail_idempotent_1",
        threadExternalId: "th_idempotent_1",
        direction: "INBOUND" as const,
        fromAddress: "bob@acme.test",
        fromName: "Bob Acme",
        toAddresses: ["csm@company.test"],
        subject: "Feature request discussion",
        bodyText: "Can we get API access for bulk exports?",
        sentAt: new Date("2026-11-05T08:00:00Z"),
      },
    ];

    const integration = await db.integration.create({
      data: {
        workspaceId: admin.workspaceId,
        provider: "MICROSOFT_EMAIL",
        status: "CONNECTED",
      },
    });

    const target = {
      workspaceId: admin.workspaceId,
      integrationId: integration.id,
      source: "MICROSOFT_EMAIL" as const,
    };

    // First sync
    const res1 = await ingestBatch(target, { kind: "mail", records: mailBatch });
    expect(res1.counts.created).toBe(1);

    // Second sync with identical payload
    const res2 = await ingestBatch(target, { kind: "mail", records: mailBatch });
    expect(res2.counts.created).toBe(0);
    expect(res2.counts.unchanged).toBe(1);

    const messages = await db.message.findMany({ where: { workspaceId: admin.workspaceId } });
    expect(messages).toHaveLength(1);
  });

  it("write-back gate: draft in mailbox is refused without write-back enabled", async () => {
    const { actor: admin } = await createTestAdmin("email-wb-gate");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Bravo Systems",
        domain: "bravo.test",
        tier: "MID_TOUCH",
      },
    });

    await db.externalRef.create({
      data: {
        workspaceId: admin.workspaceId,
        source: "GMAIL",
        objectType: "Account",
        internalType: "Account",
        internalId: account.id,
        externalId: "gmail_acc_1",
      },
    });

    // Create integration with writeBackEnabled: false
    const integration = await db.integration.create({
      data: {
        workspaceId: admin.workspaceId,
        provider: "GOOGLE_EMAIL",
        status: "CONNECTED",
        credentialsEnc: sealCredentials({
          accessToken: "fixture-gmail-access-token",
          refreshToken: "fixture-gmail-refresh-token",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        writeBackEnabled: false,
        writeBackFields: [],
      },
    });

    // Requesting write-back when disabled throws WriteBackRefusedError
    await expect(
      requestWriteBack(admin, integration.id, {
        accountId: account.id,
        field: "draft",
        value: "Draft email content",
      }),
    ).rejects.toThrow("Write-back is off for Gmail, so nothing was changed there.");

    // Enable write-back for field "draft"
    await setWriteBack(admin, integration.id, {
      enabled: true,
      fields: ["draft"],
    });

    // Now requestWriteBack succeeds and creates an approval
    const r1 = await requestWriteBack(admin, integration.id, {
      accountId: account.id,
      field: "draft",
      value: "Draft email content",
    });
    expect(r1.status).toBe("PENDING_APPROVAL");

    await db.approval.update({
      where: { id: r1.approvalId },
      data: {
        status: "APPROVED",
        decidedById: admin.membershipId,
        decidedAt: new Date(),
        decidedVia: "APP",
      },
    });

    // In fixture mode, executeApprovedWriteBack pushes successfully
    const transport = createFixtureTransport(loadFixture("google-email", "messages"));
    const pushedResult = await executeApprovedWriteBack(
      admin,
      r1.approvalId,
      {
        transport: () => transport,
      },
    );
    expect(pushedResult.status).toBe("PUSHED");

    // Live refusal check (D-116): if transport is live and WRITE_BACK_LIVE is false, it returns REFUSED
    const r2 = await requestWriteBack(admin, integration.id, {
      accountId: account.id,
      field: "draft",
      value: "Another draft email",
    });
    expect(r2.status).toBe("PENDING_APPROVAL");

    await db.approval.update({
      where: { id: r2.approvalId },
      data: {
        status: "APPROVED",
        decidedById: admin.membershipId,
        decidedAt: new Date(),
        decidedVia: "APP",
      },
    });

    const liveTransport = { ...transport, mode: "live" as const };
    const refusedResult = await executeApprovedWriteBack(
      admin,
      r2.approvalId,
      {
        writeBackLive: false,
        transport: () => liveTransport,
      },
    );
    expect(refusedResult.status).toBe("REFUSED");
  });
});
