import { describe, expect, it } from "vitest";
import type { AiProvider } from "@/lib/ai";
import { utcMidnight } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { getAgent, runAgent } from "@/modules/agents/service";
import { loadChampionGuard } from "../champion-guard.service";

/**
 * Champion Guard over real records (M9 B4, Rules 1, 3): the card appears only when the champion is
 * gone or silent, names the next-best people with their sources, and the intro draft is an
 * Approval for a person; the model cannot pick someone the records did not rank.
 */
const ASOF = "2026-11-02";

async function world(label: string, o: { champion: "bounced" | "active" | "silent" | "none" }) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: "Brightwell",
      tier: "HIGH_TOUCH",
      ownerMembershipId: actor.membershipId,
    },
  });
  const mk = (name: string, email: string | null, extra: object = {}) =>
    db.contact.create({ data: { workspaceId: ws, accountId: account.id, name, email, ...extra } });
  const maya = await mk(
    "Maya Ortiz",
    "maya@b.test",
    o.champion === "bounced"
      ? { status: "BOUNCED", statusChangedAt: new Date("2026-10-27T10:00:00Z") }
      : {},
  );
  const ben = await mk("Ben Okafor", "ben@b.test", { title: "CFO" });
  const lena = await mk("Lena Brooks", "lena@b.test");
  const role = (contactId: string, r: "CHAMPION" | "DECISION_MAKER" | "DAILY_USER", from: string) =>
    db.stakeholderRole.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        contactId,
        role: r,
        validFrom: utcMidnight(from),
      },
    });
  if (o.champion !== "none") await role(maya.id, "CHAMPION", "2025-01-01");
  await role(ben.id, "DECISION_MAKER", "2025-01-01");
  await role(lena.id, "DAILY_USER", "2025-02-01");
  const conv = await db.conversation.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      channel: "EMAIL",
      subject: "s",
      startedAt: new Date("2026-10-20"),
      lastMessageAt: new Date("2026-10-20"),
    },
  });
  const inbound = (fromContactId: string, at: string) =>
    db.message.create({
      data: {
        workspaceId: ws,
        accountId: account.id,
        conversationId: conv.id,
        direction: "INBOUND",
        fromContactId,
        sentAt: new Date(at),
        subject: "s",
        bodyText: "hi",
      },
    });
  if (o.champion === "active") await inbound(maya.id, "2026-10-30T10:00:00Z");
  if (o.champion === "silent") await inbound(maya.id, "2026-08-01T10:00:00Z");
  await inbound(ben.id, "2026-10-21T10:00:00Z");
  return { actor, db, ws, account, maya, ben, lena };
}

describe("loadChampionGuard", () => {
  it("a bounced champion: the card names the next-best contacts, decision maker first, with sources", async () => {
    const w = await world("CgBounced", { champion: "bounced" });
    const g = await loadChampionGuard(w.actor, w.account.id, ASOF);
    expect(g).toMatchObject({
      champion: { contactId: w.maya.id, name: "Maya Ortiz", state: "GONE" },
    });
    expect(g!.candidates.map((c) => c.name)).toEqual(["Ben Okafor", "Lena Brooks"]);
    expect(g!.candidates[0]!.reasons.map((r) => r.text)).toContain("Decision maker");
    expect(g!.reason).toMatch(/bounced|no longer/i);
  });

  it("a silent champion shows the card with the days of silence", async () => {
    const w = await world("CgSilent", { champion: "silent" });
    const g = await loadChampionGuard(w.actor, w.account.id, ASOF);
    expect(g!.champion.state).toBe("SILENT");
    expect(g!.reason).toMatch(/93 days/);
  });

  it("an active champion, or no champion on record, shows no card (nothing is asserted)", async () => {
    expect(
      await loadChampionGuard(
        (await world("CgActive", { champion: "active" })).actor,
        (await world("CgActive2", { champion: "active" })).account.id,
        ASOF,
      ),
    ).toBeNull();
    const none = await world("CgNone", { champion: "none" });
    expect(await loadChampionGuard(none.actor, none.account.id, ASOF)).toBeNull();
  });

  it("another workspace's account is not found", async () => {
    const a = await world("CgIsoA", { champion: "bounced" });
    const b = await world("CgIsoB", { champion: "bounced" });
    expect(await loadChampionGuard(b.actor, a.account.id, ASOF)).toBeNull();
  });
});

describe("Champion Guard agent", () => {
  const provider = (cite: string): AiProvider => ({
    name: "recorded",
    async generateStructured<T>() {
      return {
        output: {
          reasoningSummary: "r",
          confidence: 0.8,
          proposedActions: [],
          citations: [{ sourceType: "Contact", sourceId: cite }],
          whyThisPerson: "Ben is the decision maker and wrote to us on Oct 21.",
          subject: "Introducing myself while Maya is away",
          body: "Hi Ben,\n\nI look after Brightwell's account with us. I understand Maya may not be reachable, so I wanted to introduce myself and offer a short call.\n\nBest,\nLeo",
        } as T,
        stopReason: "end_turn",
        model: "recorded",
        requestId: null,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
  });

  it("drafts an intro to a ranked candidate as an Approval at DRAFT_FOR_APPROVAL, and sends nothing", async () => {
    const w = await world("CgDraft", { champion: "bounced" });
    const out = await runAgent(
      w.actor,
      getAgent("champion-guard"),
      {
        accountId: w.account.id,
        candidateContactId: w.ben.id,
        requestedByMembershipId: w.actor.membershipId,
        nonce: "n1",
      },
      { type: "champion", id: `${w.account.id}:n1` },
      { provider: provider(w.ben.id) },
    );
    expect(out).toMatchObject({ kind: "run", status: "SUCCEEDED" });
    const approval = await w.db.approval.findFirstOrThrow({ where: { accountId: w.account.id } });
    expect(approval).toMatchObject({
      kind: "SEND_EMAIL",
      status: "PENDING",
      requiredLevel: "DRAFT_FOR_APPROVAL",
    });
    const draft = await w.db.outboundMessage.findFirstOrThrow({
      where: { approvalId: approval.id },
    });
    expect(draft).toMatchObject({ contactId: w.ben.id, status: "AWAITING_APPROVAL" });
    expect(await w.db.outboundMessage.count({ where: { status: "SENT" } })).toBe(0);
  });

  it("refuses a candidate the records did not rank (the model and the caller cannot pick)", async () => {
    const w = await world("CgRefuse", { champion: "bounced" });
    const stranger = await w.db.contact.create({
      data: { workspaceId: w.ws, accountId: w.account.id, name: "Someone Else", email: null },
    });
    const out = await runAgent(
      w.actor,
      getAgent("champion-guard"),
      { accountId: w.account.id, candidateContactId: stranger.id, nonce: "n2" },
      { type: "champion", id: `${w.account.id}:n2` },
      { provider: provider(stranger.id) },
    );
    expect(out.kind === "run" && out.status).not.toBe("SUCCEEDED");
    expect(await w.db.approval.count()).toBe(0);
  });

  it("makes nothing when the champion is fine (no card, no draft)", async () => {
    const w = await world("CgFine", { champion: "active" });
    const out = await runAgent(
      w.actor,
      getAgent("champion-guard"),
      { accountId: w.account.id, candidateContactId: w.ben.id, nonce: "n3" },
      { type: "champion", id: `${w.account.id}:n3` },
      { provider: provider(w.ben.id) },
    );
    expect(out.kind === "run" && out.status).not.toBe("SUCCEEDED");
    expect(await w.db.approval.count()).toBe(0);
  });
});
