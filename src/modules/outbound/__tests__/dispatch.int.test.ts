import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { rawDb } from "@/lib/db/raw";
import { scopedDb, type ScopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { dispatch, DispatchRefusedError } from "../dispatch";

/**
 * The single send path (M4 §5, Rule 3; founder points 2 and A). A fake transport records what
 * would have left; nothing is emailed. Every case checks the message row and the audit trail.
 */
const now = () => new Date("2026-11-03T15:00:00Z");

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
let admin: Awaited<ReturnType<typeof createTestAdmin>>["actor"];
let viewerId: string;
let accountId: string;

beforeAll(async () => {
  ({ actor: admin } = await createTestAdmin("Dispatch"));
  ws = admin.workspaceId;
  db = scopedDb(admin);
  accountId = (
    await db.account.create({
      data: {
        workspaceId: ws,
        name: "Brightwell",
        tier: "HIGH_TOUCH",
        timezone: "America/New_York",
      },
    })
  ).id;
  const user = await rawDb.user.create({
    data: { email: `viewer-${randomUUID()}@t.test`, name: "V" },
  });
  viewerId = (
    await db.membership.create({ data: { workspaceId: ws, userId: user.id, role: "VIEWER" } })
  ).id;
});

interface Opts {
  status?: "PENDING" | "APPROVED" | "REJECTED" | "EDITED_APPROVED";
  decidedBy?: string;
  level?: "DRAFT_FOR_APPROVAL" | "NOTIFY_ONLY";
  proof?: unknown[];
  email?: string;
  contactStatus?: "ACTIVE" | "BOUNCED" | "LEFT";
  sendMode?: "APPROVED" | "AUTO";
  body?: string;
  approvedBody?: string;
  aiRunStatus?: "SUCCEEDED" | "UNCITED";
  sensitive?: boolean;
}

async function draft(o: Opts = {}) {
  const email = o.email ?? `maya-${randomUUID().slice(0, 8)}@brightwell.test`;
  const contact = await db.contact.create({
    data: { workspaceId: ws, accountId, name: "Maya", email, status: o.contactStatus ?? "ACTIVE" },
  });
  const run = o.aiRunStatus
    ? await db.agentRun.create({
        data: {
          workspaceId: ws,
          agentKey: "outreach",
          agentVersion: "1.0.0",
          promptName: "outreach",
          promptVersion: "1.0.0",
          model: "m",
          modelTier: "standard",
          triggerType: "t",
          triggerId: randomUUID(),
          idempotencyKey: randomUUID(),
          status: o.aiRunStatus,
          output: {},
          reasoningSummary: "r",
          confidence: 0.5,
          errorCode: o.aiRunStatus === "SUCCEEDED" ? null : "UNCITED",
        },
      })
    : null;
  const decided = o.status && o.status !== "PENDING";
  const approval = await db.approval.create({
    data: {
      workspaceId: ws,
      accountId,
      kind: "SEND_EMAIL",
      reason: "Usage dropped",
      proof: (o.proof ?? [{ sourceType: "Signal", sourceId: "s1" }]) as object[],
      requiredLevel: o.level ?? "DRAFT_FOR_APPROVAL",
      status: o.status ?? "APPROVED",
      isSensitive: o.sensitive ?? false,
      sensitiveReasons: o.sensitive ? ["cancellation"] : [],
      ...(decided || o.status === undefined
        ? {
            decidedById: o.decidedBy ?? admin.membershipId,
            decidedAt: now(),
            decidedVia: "APP" as const,
          }
        : {}),
      ...(o.status === "EDITED_APPROVED" ? { editDiff: { fromVersion: 1, toVersion: 2 } } : {}),
    },
  });
  const body = o.body ?? "Hi Maya, want a quick walkthrough of the dashboards?";
  const m = await db.outboundMessage.create({
    data: {
      workspaceId: ws,
      accountId,
      contactId: contact.id,
      toEmail: email,
      approvalId: o.sendMode === "AUTO" ? null : approval.id,
      subject: "Checking in",
      bodyText: body,
      status: "AWAITING_APPROVAL",
      sendMode: o.sendMode ?? "APPROVED",
      origin: run ? "AI" : "HUMAN",
      agentRunId: run?.id ?? null,
    },
  });
  await db.draftRevision.create({
    data: {
      workspaceId: ws,
      approvalId: approval.id,
      outboundMessageId: m.id,
      version: 1,
      subject: "Checking in",
      bodyText: o.approvedBody ?? body,
    },
  });
  return { m, approval, contact };
}

async function refused(id: string, guard: RegExp) {
  const { transport, sent } = fakeTransport();
  const err = await dispatch(admin, id, { clock: now, transport }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DispatchRefusedError);
  expect((err as DispatchRefusedError).reasons.join(" ")).toMatch(guard);
  expect(sent).toHaveLength(0);
  const row = await db.outboundMessage.findUniqueOrThrow({ where: { id } });
  expect(row.status).not.toBe("SENT");
  expect(row.sentAt).toBeNull();
  expect(
    await db.auditLog.findFirst({ where: { targetId: id, action: "outbound.refused" } }),
  ).not.toBeNull();
  return row;
}

describe("dispatch: the only way a customer email leaves", () => {
  it("an approved send succeeds with the auto-send switch off, and records guards + audit (point A)", async () => {
    const { m } = await draft();
    const { transport, sent } = fakeTransport();
    const r = await dispatch(admin, m.id, { clock: now, transport });
    expect(r).toEqual({ status: "SENT", providerMessageId: "fake-1", transport: "log" });
    expect(sent).toEqual([
      {
        workspaceId: ws,
        outboundMessageId: m.id,
        to: m.toEmail,
        subject: "Checking in",
        text: m.bodyText,
      },
    ]);
    const row = await db.outboundMessage.findUniqueOrThrow({ where: { id: m.id } });
    expect(row).toMatchObject({ status: "SENT", providerMessageId: "fake-1", transport: "log" });
    const guards = row.guardResults as Array<{ guard: string; passed: boolean }>;
    expect(guards.find((g) => g.guard === "auto_send_disabled")).toMatchObject({ passed: false });
    expect(guards.find((g) => g.guard === "approval_approved")).toMatchObject({ passed: true });
    expect(guards).toHaveLength(14);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { targetId: m.id, action: "outbound.sent" },
    });
    expect(audit.summary).toContain("log transport");
  });

  it("dispatching twice sends once", async () => {
    const { m } = await draft();
    const { transport, sent } = fakeTransport();
    await dispatch(admin, m.id, { clock: now, transport });
    expect(await dispatch(admin, m.id, { clock: now, transport })).toMatchObject({
      status: "ALREADY_SENT",
    });
    expect(sent).toHaveLength(1);
  });

  it("an automatic send with the kill switch off is blocked by guard 8, held, and sent to Approvals", async () => {
    const { m } = await draft({ sendMode: "AUTO" });
    const { transport, sent } = fakeTransport();
    const r = await dispatch(admin, m.id, { clock: now, transport });
    expect(r).toMatchObject({ status: "HELD" });
    expect(sent).toHaveLength(0);
    const row = await db.outboundMessage.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.status).toBe("HELD");
    expect(row.heldReason).toContain("Auto-send is switched off");
    const held = await db.approval.findUniqueOrThrow({ where: { id: row.approvalId! } });
    expect(held).toMatchObject({ status: "PENDING", requiredLevel: "DRAFT_FOR_APPROVAL" });
    expect(
      await db.auditLog.findFirst({ where: { targetId: m.id, action: "outbound.held" } }),
    ).not.toBeNull();
  });

  it("an automatic send on a sensitive topic is held as sensitive (guard 6)", async () => {
    const { m } = await draft({
      sendMode: "AUTO",
      body: "Before you cancel, can we talk about pricing?",
    });
    const r = await dispatch(admin, m.id, { clock: now, transport: fakeTransport().transport });
    expect(r).toMatchObject({ status: "HELD" });
    const row = await db.outboundMessage.findUniqueOrThrow({ where: { id: m.id } });
    const guards = row.guardResults as Array<{ guard: string; passed: boolean }>;
    expect(guards.find((g) => g.guard === "sensitive_topic")).toMatchObject({ passed: false });
    const held = await db.approval.findUniqueOrThrow({ where: { id: row.approvalId! } });
    expect(held).toMatchObject({
      isSensitive: true,
      sensitiveReasons: ["cancellation", "pricing"],
    });
  });

  it("sending without an approved approval throws", async () => {
    const { m } = await draft({ status: "PENDING" });
    await refused(m.id, /approval_approved/);
  });

  it("a REJECTED approval cannot send", async () => {
    const { m } = await draft({ status: "REJECTED" });
    await refused(m.id, /approval_approved/);
  });

  it("an approval decided by someone without approvals:decide cannot send", async () => {
    const { m } = await draft({ decidedBy: viewerId });
    await refused(m.id, /approver_permitted/);
  });

  it("an approval at the wrong level cannot send", async () => {
    const { m } = await draft({ level: "NOTIFY_ONLY" });
    await refused(m.id, /approval_level/);
  });

  it("a draft with no source citations cannot send", async () => {
    const { m } = await draft({ proof: [] });
    await refused(m.id, /has_sources/);
  });

  it("an AI draft from a run that did not succeed cannot send", async () => {
    const { m } = await draft({ aiRunStatus: "UNCITED" });
    await refused(m.id, /ai_run_succeeded/);
  });

  it("text that differs from the approved version cannot send", async () => {
    const { m } = await draft({ approvedBody: "the approved words" });
    await refused(m.id, /approved_version/);
  });

  it("a suppressed address never sends, even when approved", async () => {
    const email = `gone-${randomUUID().slice(0, 6)}@brightwell.test`;
    await db.emailSuppression.create({ data: { workspaceId: ws, email, reason: "UNSUBSCRIBED" } });
    const { m } = await draft({ email });
    const row = await refused(m.id, /suppressed/);
    expect(row.status).toBe("HELD");
  });

  it("a bounced or departed contact never receives an approved send", async () => {
    for (const contactStatus of ["BOUNCED", "LEFT"] as const) {
      const { m } = await draft({ contactStatus });
      await refused(m.id, /suppressed/);
    }
  });

  it("a provider failure marks the message FAILED and audits it; nothing is reported as sent", async () => {
    const { m } = await draft();
    const transport = {
      name: "log" as const,
      async send(): Promise<{ id: string }> {
        throw new Error("provider down");
      },
    };
    await expect(dispatch(admin, m.id, { clock: now, transport })).rejects.toThrow("provider down");
    expect(await db.outboundMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({
      status: "FAILED",
      sentAt: null,
    });
    expect(
      await db.auditLog.findFirst({ where: { targetId: m.id, action: "outbound.failed" } }),
    ).not.toBeNull();
  });
});
