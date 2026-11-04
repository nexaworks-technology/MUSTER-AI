import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/permissions";
import { rawDb } from "@/lib/db/raw";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import type { Actor } from "@/modules/accounts/service";
import { captureVoiceSample, listVoiceSamples, removeVoiceSample } from "../voice.service";
import { outreach } from "../definitions/outreach";
import { runAgent } from "../executor";
import type { AiProvider } from "@/lib/ai";

async function createActorWithRole(workspaceId: string, role: "CSM" | "VIEWER") {
  const user = await rawDb.user.create({
    data: {
      email: `${role.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`,
      name: `Test ${role}`,
    },
  });
  const membership = await rawDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return tx.membership.create({
      data: {
        workspaceId,
        userId: user.id,
        role,
        canViewRevenue: false,
      },
    });
  });
  return {
    workspaceId,
    userId: user.id,
    membershipId: membership.id,
    role: membership.role,
    canViewRevenue: membership.canViewRevenue,
    bookScope: membership.bookScope,
    user: { id: user.id, email: user.email, name: user.name },
  };
}

describe("S9: VoiceSample Capture & Outreach Extension (spec §5, §8, Rule 8)", () => {
  it("Admin captures VoiceSample and it is audited; CSM and Viewer are forbidden", async () => {
    const { workspace, actor: admin } = await createTestAdmin("VoiceSampleAdmin");
    const csm = await createActorWithRole(workspace.id, "CSM");
    const viewer = await createActorWithRole(workspace.id, "VIEWER");
    const db = scopedDb(admin);

    // CSM and Viewer cannot capture
    await expect(
      captureVoiceSample(csm as unknown as Actor, { subject: "Subj", bodyText: "Body" }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      captureVoiceSample(viewer as unknown as Actor, { subject: "Subj", bodyText: "Body" }),
    ).rejects.toThrow(ForbiddenError);

    // Admin captures
    const sample = await captureVoiceSample(admin, {
      subject: "Great catching up on the integration",
      bodyText: "Hi Alex,\n\nGlad we connected today on the rollout plan.\n\nBest,\nSarah",
    });
    expect(sample.id).toBeDefined();
    expect(sample.subject).toBe("Great catching up on the integration");
    expect(sample.approvedForVoice).toBe(true);

    // Audit log written
    const audit = await db.auditLog.findFirst({
      where: { workspaceId: workspace.id, action: "voice_sample.captured", targetId: sample.id },
    });
    expect(audit).toBeDefined();
    expect(audit?.actorId).toBe(admin.userId);

    // List samples
    const list = await listVoiceSamples(admin);
    expect(list.some((s) => s.id === sample.id)).toBe(true);

    // Remove sample
    await removeVoiceSample(admin, sample.id);
    const updated = await db.voiceSample.findUniqueOrThrow({ where: { id: sample.id } });
    expect(updated.approvedForVoice).toBe(false);
  });

  it("Cross-tenant: captureVoiceSample rejects OutboundMessage from another workspace (Rule 8)", async () => {
    const { actor: admin1 } = await createTestAdmin("VoiceWS1");
    const { workspace: ws2, actor: admin2 } = await createTestAdmin("VoiceWS2");

    const db2 = scopedDb(admin2);
    const acc2 = await db2.account.create({
      data: { workspaceId: ws2.id, name: "WS2 Acc", tier: "HIGH_TOUCH" },
    });
    const contact2 = await db2.contact.create({
      data: { workspaceId: ws2.id, accountId: acc2.id, name: "Contact 2", email: "c2@test.com" },
    });
    const msg2 = await db2.outboundMessage.create({
      data: {
        workspaceId: ws2.id,
        accountId: acc2.id,
        contactId: contact2.id,
        toEmail: "c2@test.com",
        subject: "WS2 Sent Email",
        bodyText: "WS2 text",
        sourceKey: "ws2-msg-1",
        status: "SENT",
        providerMessageId: "prov-msg-2",
        sentAt: new Date(),
      },
    });

    // Admin1 cannot capture msg2 from WS2
    await expect(
      captureVoiceSample(admin1, {
        outboundMessageId: msg2.id,
        subject: "Stolen Voice",
        bodyText: "Stolen body",
      }),
    ).rejects.toThrow(/not found in this workspace/);
  });

  it("Outreach agent 1.1.0 includes approved VoiceSamples in its context bundle / prompt vars", async () => {
    const { workspace, actor: admin } = await createTestAdmin("OutreachVoiceWS");
    const db = scopedDb(admin);

    // Add approved voice sample
    await captureVoiceSample(admin, {
      subject: "Approved Voice Sample Subject",
      bodyText: "This is our signature tone of voice: polite, proactive, and concise.",
    });

    const account = await db.account.create({
      data: { workspaceId: workspace.id, name: "Acme Corp", tier: "LONG_TAIL" },
    });
    const contact = await db.contact.create({
      data: { workspaceId: workspace.id, accountId: account.id, name: "Jane Doe", email: "jane@acme.test" },
    });
    const signal = await db.signal.create({
      data: {
        workspaceId: workspace.id,
        accountId: account.id,
        ruleKey: "adoption_drop",
        ruleVersion: 1,
        category: "USAGE",
        severity: "WARN",
        polarity: "RISK",
        title: "Adoption Drop Detected",
        explanation: "Feature usage dropped 40%",
        evidence: [{ sourceType: "FeatureUsage", value: 60 }],
        values: {},
        params: {},
        dedupeKey: `sig-voice-${Date.now()}`,
        firstSeenAt: new Date("2026-11-02"),
        lastSeenAt: new Date("2026-11-02"),
      },
    });

    const mockProvider: AiProvider = {
      name: "recorded",
      async generateStructured<T>() {
        return {
          output: {
            reasoningSummary: "Drafted check-in using workspace voice styling.",
            confidence: 0.85,
            citations: [{ sourceType: "Signal", sourceId: signal.id }],
            proposedActions: [],
            subject: "Checking in on your feature adoption",
            body: "Hi Jane,\n\nNoticed a drop in feature activity. Let us know how we can assist!\n\nBest,\nCS Team",
          } as unknown as T,
          stopReason: "end_turn",
          model: "mock-model",
          requestId: null,
          inputTokens: 10,
          outputTokens: 10,
          latencyMs: 1,
        };
      },
    };

    const out = await runAgent(
      admin,
      outreach,
      {
        sourceType: "Signal",
        sourceId: signal.id,
        contactId: contact.id,
        requestedByMembershipId: admin.membershipId,
        nonce: `nonce-${Date.now()}`,
      },
      { type: "signal", id: signal.id },
      { provider: mockProvider },
    );

    expect(out.kind).toBe("run");
    if (out.kind !== "run") throw new Error("not run");
    expect(out.status).toBe("SUCCEEDED");

    // Verify AgentRun was recorded with prompt version 1.1.0 and effects
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: out.runId } });
    expect(run.agentVersion).toBe("1.1.0");
    expect(run.promptVersion).toBe("1.1.0");
    const effects = run.effects as Array<{ type: string; id: string }>;
    expect(effects.some((e) => e.type === "Approval")).toBe(true);
  });
});
