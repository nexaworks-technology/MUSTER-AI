import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import type { AiProvider } from "@/lib/ai";
import {
  exportQbrPdf,
  generateQbr,
  lockQbrDocument,
  updateQbrNarrative,
} from "../service";

const makeMockQbrProvider = (accountId: string): AiProvider => ({
  name: "recorded",
  async generateStructured<T>() {
    return {
      output: {
        reasoningSummary: "Generated comprehensive QBR narrative.",
        confidence: 0.95,
        citations: [{ sourceType: "Account", sourceId: accountId }],
        proposedActions: [],
        title: "Q3 2026 Executive Business Review",
        summary: "Strong quarter with high adoption across all key modules.",
        decisions: ["Expanded licenses for support team"],
        actionItems: [{ title: "Schedule technical review", ownerName: "CSM" }],
        suggestedQuestions: [],
        healthHighlights: ["Good overall health"],
        metrics: { overallHealth: 85, band: "GOOD" },
      } as T,
      stopReason: "end_turn",
      model: "recorded",
      requestId: null,
      inputTokens: 50,
      outputTokens: 100,
      latencyMs: 10,
    };
  },
});

describe("Slice 8: QBR Narrative generation, editor validation, and document locking", () => {
  it("generates a QBR document with locked metrics, AI origin, agentRunId, and block narrative", async () => {
    const { actor: admin } = await createTestAdmin("qbr-gen");
    const ws = admin.workspaceId;
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: ws,
        name: "Northgate QBR Test",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
        arrMinor: 12000000n,
        arrCurrency: "USD",
      },
    });

    const doc = await generateQbr(
      admin,
      {
        accountId: account.id,
        period: "Q3 2026",
      },
      { provider: makeMockQbrProvider(account.id) },
    );

    expect(doc.kind).toBe("QBR");
    expect(doc.origin).toBe("AI");
    expect(doc.agentRunId).not.toBeNull();
    expect(doc.locked).toBe(false);

    const body = doc.body as Record<string, unknown>;
    expect(body.period).toBe("Q3 2026");
    expect(body.metrics).toBeDefined();
    const metrics = body.metrics as Record<string, unknown>;
    expect((metrics.revenue as Record<string, unknown>).arrFormatted).toBe("$120,000");

    const blocks = body.blocks as Array<{ id: string; type: string; title: string; text: string }>;
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it("refuses generation when period label violates closed allowlist", async () => {
    const { actor: admin } = await createTestAdmin("qbr-invalid-period");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Bad Period Account",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });

    await expect(
      generateQbr(
        admin,
        {
          accountId: account.id,
          period: "$50,000 revenue target",
        },
        { provider: makeMockQbrProvider(account.id) },
      ),
    ).rejects.toThrow(/closed allowlist|forbidden/i);
  });

  it("updates narrative text successfully when prose is clean", async () => {
    const { actor: admin } = await createTestAdmin("qbr-edit-clean");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Clean Edit Account",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });

    const doc = await generateQbr(
      admin,
      {
        accountId: account.id,
        period: "Q3 2026",
      },
      { provider: makeMockQbrProvider(account.id) },
    );

    const updatedBlocks = [
      {
        id: "b1",
        type: "executive_summary",
        title: "Executive Summary",
        text: "The customer achieved significant milestone progress during this business cycle.",
      },
    ];

    const updated = await updateQbrNarrative(admin, doc.id, updatedBlocks);
    const body = updated.body as Record<string, unknown>;
    const blocks = body.blocks as Array<{ id: string; text: string }>;
    expect(blocks[0]!.text).toBe(
      "The customer achieved significant milestone progress during this business cycle.",
    );
    // Locked metrics remain intact
    expect(body.metrics).toBeDefined();
  });

  it("refuses narrative update when text injects raw currency strings", async () => {
    const { actor: admin } = await createTestAdmin("qbr-edit-tainted");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Tainted Edit Account",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });

    const doc = await generateQbr(
      admin,
      {
        accountId: account.id,
        period: "Q3 2026",
      },
      { provider: makeMockQbrProvider(account.id) },
    );

    const taintedBlocks = [
      {
        id: "b1",
        type: "executive_summary",
        title: "Executive Summary",
        text: "We increased their ARR by $45,000 directly.",
      },
    ];

    await expect(updateQbrNarrative(admin, doc.id, taintedBlocks)).rejects.toThrow(
      /raw currency|locked metric panel/i,
    );
  });

  it("locks QBR document, refuses further edits, and emits business_review.followup outbox event", async () => {
    const { actor: admin } = await createTestAdmin("qbr-lock");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "Lock Account",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });

    const doc = await generateQbr(
      admin,
      {
        accountId: account.id,
        period: "Q3 2026",
      },
      { provider: makeMockQbrProvider(account.id) },
    );

    const locked = await lockQbrDocument(admin, doc.id);
    expect(locked.locked).toBe(true);

    // Editing locked doc fails
    await expect(
      updateQbrNarrative(admin, doc.id, [
        { id: "b1", type: "summary", title: "Summary", text: "New text after lock" },
      ]),
    ).rejects.toThrow(/locked/i);

    // Check outbox event was emitted
    const events = await db.outboxEvent.findMany({
      where: {
        workspaceId: admin.workspaceId,
        type: "business_review.followup",
      },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect((events[0]!.payload as Record<string, unknown>).documentId).toBe(doc.id);
  });

  it("exports QBR as a PDF document", async () => {
    const { actor: admin } = await createTestAdmin("qbr-pdf");
    const db = scopedDb(admin);

    const account = await db.account.create({
      data: {
        workspaceId: admin.workspaceId,
        name: "PDF Account",
        tier: "HIGH_TOUCH",
        ownerMembershipId: admin.membershipId,
      },
    });

    const doc = await generateQbr(
      admin,
      {
        accountId: account.id,
        period: "Q3 2026",
      },
      { provider: makeMockQbrProvider(account.id) },
    );

    const pdf = await exportQbrPdf(admin, doc.id);
    expect(pdf.mimeType).toBe("application/pdf");
    expect(pdf.filename).toMatch(/Q3_2026.*\.pdf/);
    expect(pdf.buffer.length).toBeGreaterThan(0);
    expect(pdf.buffer.toString("utf-8")).toMatch(/^%PDF/);
  });
});
