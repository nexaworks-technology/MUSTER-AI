import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import type { Actor } from "@/modules/accounts/service";
import { createTestAdmin } from "@/test/fixtures";
import {
  ApprovalNotFoundError,
  ApprovalStateError,
  approve,
  bulkDecide,
  editAndApprove,
  getApproval,
  listApprovals,
  reject,
  requestApproval,
} from "../service";

/**
 * Approvals: the only door out (M4 §2, rule 4; Q-31; D-76). A fake transport records sends.
 */
const clock = () => new Date("2026-11-03T15:00:00Z");
const sent: string[] = [];
const transport = {
  name: "log" as const,
  async send(m: { outboundMessageId: string }) {
    sent.push(m.outboundMessageId);
    return { id: `fake-${sent.length}` };
  },
};
const opts = { clock, dispatch: { clock, transport } };

let db: ScopedDb;
let admin: Actor;
let leo: Actor;
let dana: Actor;
let viewer: Actor;
let leoAccount: string;
let otherAccount: string;
let unowned: string;

async function member(
  ws: string,
  role: "CSM" | "CS_LEADER" | "VIEWER",
  name: string,
): Promise<Actor> {
  const user = await rawDb.user.create({ data: { email: `${name}-${randomUUID()}@t.test`, name } });
  const m = await scopedDb({ workspaceId: ws }).membership.create({
    data: { workspaceId: ws, userId: user.id, role },
  });
  return {
    workspaceId: ws,
    userId: user.id,
    membershipId: m.id,
    role,
    canViewRevenue: false,
    bookScope: m.bookScope,
  };
}

beforeAll(async () => {
  const { actor } = await createTestAdmin("Approvals");
  admin = actor;
  db = scopedDb(admin);
  leo = await member(admin.workspaceId, "CSM", "Leo");
  dana = await member(admin.workspaceId, "CS_LEADER", "Dana");
  viewer = await member(admin.workspaceId, "VIEWER", "Vic");
  const acc = (name: string, owner: string | null) =>
    db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name,
        tier: "HIGH_TOUCH",
        ownerMembershipId: owner,
        timezone: "America/New_York",
      },
    });
  leoAccount = (await acc("Brightwell", leo.membershipId)).id;
  otherAccount = (await acc("Quillmark", admin.membershipId)).id;
  unowned = (await acc("Pool account", null)).id;
});

async function emailDraft(accountId: string, o: { body?: string; trigger?: string[] } = {}) {
  const contact = await db.contact.create({
    data: {
      workspaceId: admin.workspaceId,
      accountId,
      name: "Maya",
      email: `Maya-${randomUUID().slice(0, 6)}@b.test`,
    },
  });
  return requestApproval(admin, {
    accountId,
    kind: "SEND_EMAIL",
    reason: "Usage dropped 49% against normal",
    proof: [{ sourceType: "Signal", sourceId: "s1" }],
    triggeringText: o.trigger ?? [],
    proposedByMembershipId: leo.membershipId,
    sourceKey: `test:${randomUUID()}`,
    email: {
      contactId: contact.id,
      subject: "Checking in",
      body: o.body ?? "Hi Maya, want a quick walkthrough?",
      origin: "HUMAN",
    },
  });
}

describe("requesting an approval", () => {
  it("creates the approval, the draft and version 1, assigned to the account owner, audited", async () => {
    const a = await emailDraft(leoAccount);
    expect(a).toMatchObject({
      status: "PENDING",
      requiredLevel: "DRAFT_FOR_APPROVAL",
      isSensitive: false,
      assigneeId: leo.membershipId,
    });
    const full = await getApproval(admin, a.id);
    expect(full.outboundMessages).toHaveLength(1);
    expect(full.outboundMessages[0]!.toEmail).toBe(full.outboundMessages[0]!.toEmail.toLowerCase());
    expect(full.revisions.map((r) => r.version)).toEqual([1]);
    expect(
      await db.notification.findFirst({
        where: { refId: a.id, recipientMembershipId: leo.membershipId },
      }),
    ).not.toBeNull();
    expect(
      await db.auditLog.findFirst({ where: { targetId: a.id, action: "approval.requested" } }),
    ).not.toBeNull();
  });

  it("is idempotent by sourceKey", async () => {
    const contact = await db.contact.create({
      data: { workspaceId: admin.workspaceId, accountId: leoAccount, name: "K", email: "k@b.test" },
    });
    const input = {
      accountId: leoAccount,
      kind: "SEND_EMAIL" as const,
      reason: "r",
      proof: [{ sourceType: "Signal", sourceId: "s1" }],
      sourceKey: "same-key",
      email: { contactId: contact.id, subject: "s", body: "b", origin: "HUMAN" as const },
    };
    const first = await requestApproval(admin, input);
    expect((await requestApproval(admin, input)).id).toBe(first.id);
    expect(await db.outboundMessage.count({ where: { sourceKey: "same-key" } })).toBe(1);
  });

  it("flags a cancellation as sensitive from the triggering ticket, capped at DRAFT_FOR_APPROVAL", async () => {
    const a = await emailDraft(otherAccount, {
      trigger: ["How do I export all our data before we cancel at the end of the term?"],
    });
    expect(a).toMatchObject({
      isSensitive: true,
      sensitiveReasons: ["cancellation"],
      requiredLevel: "DRAFT_FOR_APPROVAL",
    });
  });

  it("an account with no owner is assigned to a CS Leader", async () => {
    const a = await emailDraft(unowned);
    expect(a.assigneeId).toBe(dana.membershipId);
  });

  it("refuses an approval with no proof", async () => {
    await expect(
      requestApproval(admin, {
        accountId: leoAccount,
        kind: "CREATE_TASK",
        reason: "r",
        proof: [],
        sourceKey: "np",
      }),
    ).rejects.toThrow(/at least one source/);
  });
});

describe("deciding", () => {
  it("approve → APPROVED and sent through dispatch, both audited", async () => {
    const a = await emailDraft(leoAccount);
    const r = await approve(leo, { approvalId: a.id }, opts);
    expect(r.approval).toMatchObject({
      status: "APPROVED",
      decidedById: leo.membershipId,
      decidedVia: "APP",
    });
    expect(r.send).toMatchObject({ status: "SENT" });
    expect(
      await db.auditLog.findFirst({ where: { targetId: a.id, action: "approval.approved" } }),
    ).not.toBeNull();
  });

  it("edit then approve writes version 2, keeps version 1, and sends exactly the edited text", async () => {
    const a = await emailDraft(leoAccount);
    const r = await editAndApprove(
      leo,
      {
        approvalId: a.id,
        subject: "Checking in",
        body: "Hi Maya, can we look at the dashboards together on Thursday?",
      },
      opts,
    );
    expect(r.approval).toMatchObject({
      status: "EDITED_APPROVED",
      editDiff: { fromVersion: 1, toVersion: 2, subjectChanged: false, bodyChanged: true },
    });
    expect(r.send).toMatchObject({ status: "SENT" });
    const full = await getApproval(admin, a.id);
    expect(full.revisions.map((v) => [v.version, v.bodyText])).toEqual([
      [1, "Hi Maya, want a quick walkthrough?"],
      [2, "Hi Maya, can we look at the dashboards together on Thursday?"],
    ]);
    expect(full.outboundMessages[0]).toMatchObject({
      status: "SENT",
      bodyText: "Hi Maya, can we look at the dashboards together on Thursday?",
    });
  });

  it("an edit that adds a sensitive topic marks the approval sensitive", async () => {
    const a = await emailDraft(leoAccount);
    const r = await editAndApprove(
      leo,
      { approvalId: a.id, subject: "Checking in", body: "We can offer a discount at renewal." },
      opts,
    );
    expect(r.approval).toMatchObject({ isSensitive: true, sensitiveReasons: ["pricing"] });
  });

  it("reject needs a note, cancels the draft, and it can never send", async () => {
    const a = await emailDraft(leoAccount);
    await expect(reject(leo, { approvalId: a.id, note: "" }, opts)).rejects.toThrow();
    const r = await reject(leo, { approvalId: a.id, note: "Wrong contact" }, opts);
    expect(r.approval).toMatchObject({ status: "REJECTED", decisionNote: "Wrong contact" });
    expect((await getApproval(admin, a.id)).outboundMessages[0]!.status).toBe("CANCELLED");
    await expect(approve(leo, { approvalId: a.id }, opts)).rejects.toBeInstanceOf(
      ApprovalStateError,
    );
  });

  it("a second decision is refused", async () => {
    const a = await emailDraft(leoAccount);
    await approve(leo, { approvalId: a.id }, opts);
    await expect(approve(dana, { approvalId: a.id }, opts)).rejects.toBeInstanceOf(
      ApprovalStateError,
    );
  });

  it("a CSM cannot see or decide outside their book (404); a Viewer cannot decide", async () => {
    const a = await emailDraft(otherAccount);
    await expect(getApproval(leo, a.id)).rejects.toBeInstanceOf(ApprovalNotFoundError);
    await expect(approve(leo, { approvalId: a.id }, opts)).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    );
    expect((await listApprovals(leo)).rows.every((r) => r.accountId !== otherAccount)).toBe(true);
    await expect(approve(viewer, { approvalId: a.id }, opts)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await approve(dana, { approvalId: a.id }, opts)).approval.status).toBe("APPROVED");
  });

  it("a sensitive approval is never decided from Slack (Q-31)", async () => {
    const a = await emailDraft(otherAccount, { trigger: ["We will cancel."] });
    await expect(approve(admin, { approvalId: a.id }, { ...opts, via: "SLACK" })).rejects.toThrow(
      /never from Slack/,
    );
    const plain = await emailDraft(otherAccount);
    expect(
      (await approve(admin, { approvalId: plain.id }, { ...opts, via: "SLACK" })).approval
        .decidedVia,
    ).toBe("SLACK");
  });
});

describe("bulk decide", () => {
  it("needs the exact confirmation list; a mismatch decides nothing", async () => {
    const a = await emailDraft(leoAccount);
    const b = await emailDraft(leoAccount);
    await expect(
      bulkDecide(
        leo,
        { decision: "approve", approvalIds: [a.id, b.id], confirmedIds: [a.id] },
        opts,
      ),
    ).rejects.toThrow(/does not match/);
    expect((await getApproval(leo, a.id)).status).toBe("PENDING");
    const done = await bulkDecide(
      leo,
      { decision: "approve", approvalIds: [a.id, b.id], confirmedIds: [b.id, a.id] },
      opts,
    );
    expect(done.map((d) => d.approval.status)).toEqual(["APPROVED", "APPROVED"]);
  });

  it("never bulk-approves a sensitive item; nothing in the selection is decided (D-76)", async () => {
    const plain = await emailDraft(otherAccount);
    const sensitive = await emailDraft(otherAccount, { trigger: ["Our lawyer will be in touch."] });
    const ids = [plain.id, sensitive.id];
    await expect(
      bulkDecide(admin, { decision: "approve", approvalIds: ids, confirmedIds: ids }, opts),
    ).rejects.toThrow(/sensitive/);
    expect((await getApproval(admin, plain.id)).status).toBe("PENDING");
    const rejected = await bulkDecide(
      admin,
      { decision: "reject", approvalIds: ids, confirmedIds: ids, note: "Duplicate" },
      opts,
    );
    expect(rejected.map((d) => d.approval.status)).toEqual(["REJECTED", "REJECTED"]);
  });
});
