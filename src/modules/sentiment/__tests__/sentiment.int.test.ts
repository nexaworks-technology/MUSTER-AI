import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { addExtraction } from "@/test/extraction-fixtures";
import { countQueries } from "@/test/query-counter";
import { getSentiment } from "../service";

/**
 * Sentiment & themes (M9 B5, rules 1, 3): counts come from verified extractions by code; every
 * theme shows at least one verbatim quote with a link to its source; email and call tone are shown,
 * never scored. The screen reads Extraction at display; nothing is stored for it.
 */
const ASOF = "2026-11-02";

async function world(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const mk = (name: string) =>
    db.account.create({
      data: { workspaceId: ws, name, tier: "MID_TOUCH", ownerMembershipId: actor.membershipId },
    });
  const halden = await mk("Halden Retail");
  const north = await mk("Northgate Freight");
  const conv = (accountId: string, channel: "EMAIL" | "TICKET" | "CALL", at: string) =>
    db.conversation.create({
      data: {
        workspaceId: ws,
        accountId,
        channel,
        subject: "s",
        startedAt: new Date(at),
        lastMessageAt: new Date(at),
      },
    });
  const message = async (
    accountId: string,
    channel: "EMAIL" | "TICKET",
    at: string,
    direction: "INBOUND" | "OUTBOUND" = "INBOUND",
  ) => {
    const c = await conv(accountId, channel, at);
    const m = await db.message.create({
      data: {
        workspaceId: ws,
        accountId,
        conversationId: c.id,
        direction,
        sentAt: new Date(at),
        subject: "s",
        bodyText: "text",
      },
    });
    const t =
      channel === "TICKET"
        ? await db.ticket.create({
            data: {
              workspaceId: ws,
              accountId,
              conversationId: c.id,
              subject: "CSV export fails",
              openedAt: new Date(at),
            },
          })
        : null;
    return { m, t };
  };
  const call = async (accountId: string, at: string) => {
    const c = await conv(accountId, "CALL", at);
    return db.callTranscript.create({
      data: {
        workspaceId: ws,
        conversationId: c.id,
        accountId,
        title: "Call",
        provider: "seed",
        occurredAt: new Date(at),
        text: "t",
      },
    });
  };
  const note = (accountId: string, at: string) =>
    db.note.create({
      data: {
        workspaceId: ws,
        accountId,
        body: "b",
        tags: [],
        mentionMembershipIds: [],
        createdAt: new Date(at),
      },
    });
  const next = new Map<string, number>();
  const x = (
    accountId: string,
    sourceType: "MESSAGE" | "CALL_TRANSCRIPT" | "NOTE",
    sourceId: string,
    kind: Parameters<typeof addExtraction>[1]["kind"],
    quote: string,
    payload: Record<string, unknown> = {},
  ) => {
    const itemIndex = next.get(sourceId) ?? 0;
    next.set(sourceId, itemIndex + 1);
    return addExtraction(db, {
      workspaceId: ws,
      accountId,
      sourceType,
      sourceId,
      kind,
      quote,
      payload,
      itemIndex,
    });
  };
  return { actor, db, ws, halden, north, message, call, note, x };
}

describe("getSentiment", () => {
  it("counts tone by label and by where it was read, inside the window only, never from our own messages", async () => {
    const w = await world("SentMix");
    const t = await w.message(w.halden.id, "TICKET", "2026-10-30T10:00:00Z");
    const e = await w.message(w.halden.id, "EMAIL", "2026-10-31T10:00:00Z");
    const old = await w.message(w.halden.id, "EMAIL", "2026-06-01T10:00:00Z");
    const c = await w.call(w.north.id, "2026-10-15T10:00:00Z");
    await w.x(w.halden.id, "MESSAGE", t.m.id, "SENTIMENT", "ticket words", { label: "NEGATIVE" });
    await w.x(w.halden.id, "MESSAGE", e.m.id, "SENTIMENT", "email words", { label: "NEGATIVE" });
    await w.x(w.halden.id, "MESSAGE", old.m.id, "SENTIMENT", "old words", { label: "POSITIVE" });
    await w.x(w.north.id, "CALL_TRANSCRIPT", c.id, "SENTIMENT", "call words", { label: "MIXED" });
    const s = await getSentiment(w.actor, { asOf: ASOF });
    expect(s.mix.total).toBe(3);
    expect(s.mix.byLabel).toEqual({ NEGATIVE: 2, MIXED: 1, NEUTRAL: 0, POSITIVE: 0 });
    expect(s.mix.bySource).toEqual({
      ticket: { count: 1, scored: true },
      email: { count: 1, scored: false },
      call: { count: 1, scored: false },
    });
  });

  it("themes: complaints and theme labels grouped by the fixed list, most first, `other` never", async () => {
    const w = await world("SentThemes");
    for (const d of ["2026-10-12", "2026-10-22", "2026-10-31"]) {
      const { m } = await w.message(w.halden.id, "TICKET", `${d}T10:00:00Z`);
      await w.x(w.halden.id, "MESSAGE", m.id, "THEME", "The CSV export fails.", {
        theme: "csv_export",
      });
    }
    const email = await w.message(w.halden.id, "EMAIL", "2026-11-01T10:00:00Z");
    await w.x(w.halden.id, "MESSAGE", email.m.id, "COMPLAINT", "The export failed again.", {
      theme: "csv_export",
    });
    const c = await w.call(w.north.id, "2026-10-15T10:00:00Z");
    await w.x(w.north.id, "CALL_TRANSCRIPT", c.id, "THEME", "We need to see the API limits fixed", {
      theme: "api_limits",
    });
    await w.x(w.north.id, "CALL_TRANSCRIPT", c.id, "COMPLAINT", "something odd", {
      theme: "other",
    });
    const s = await getSentiment(w.actor, { asOf: ASOF });
    expect(s.themes.map((t) => [t.theme, t.count, t.accounts])).toEqual([
      ["csv_export", 4, 1],
      ["api_limits", 1, 1],
    ]);
    expect(s.themes[0]!.label).toBe("csv export");
  });

  it("every theme shows at least one verbatim quote with a link to its source", async () => {
    const w = await world("SentQuotes");
    const { m, t } = await w.message(w.halden.id, "TICKET", "2026-10-30T10:00:00Z");
    const email = await w.message(w.halden.id, "EMAIL", "2026-10-31T10:00:00Z");
    const c = await w.call(w.north.id, "2026-10-15T10:00:00Z");
    const n = await w.note(w.north.id, "2026-10-16T10:00:00Z");
    await w.x(w.halden.id, "MESSAGE", m.id, "THEME", "ticket quote", { theme: "csv_export" });
    await w.x(w.halden.id, "MESSAGE", email.m.id, "COMPLAINT", "email quote", { theme: "billing" });
    await w.x(w.north.id, "CALL_TRANSCRIPT", c.id, "THEME", "call quote", { theme: "api_limits" });
    await w.x(w.north.id, "NOTE", n.id, "COMPLAINT", "note quote", { theme: "performance" });
    const s = await getSentiment(w.actor, { asOf: ASOF });
    expect(s.themes).toHaveLength(4);
    for (const th of s.themes) {
      expect(th.quotes.length, th.theme).toBeGreaterThan(0);
      for (const q of th.quotes) {
        expect(q.quote.length).toBeGreaterThan(0);
        expect(q.href).toMatch(/^\/accounts\//);
      }
    }
    const link = (theme: string) => s.themes.find((x) => x.theme === theme)!.quotes[0]!;
    expect(link("csv_export")).toMatchObject({
      quote: "ticket quote",
      href: `/accounts/${w.halden.id}/tickets#ticket-${t!.id}`,
      account: { name: "Halden Retail" },
      date: "2026-10-30",
    });
    expect(link("billing").href).toBe(
      `/accounts/${w.halden.id}/conversations?message=${email.m.id}#message-${email.m.id}`,
    );
    expect(link("api_limits").href).toBe(`/accounts/${w.north.id}/conversations`);
    expect(link("performance").href).toBe(`/accounts/${w.north.id}/notes`);
  });

  it("a theme filter lists every quote for that theme, not only a sample", async () => {
    const w = await world("SentTheme");
    for (let i = 0; i < 6; i++) {
      const { m } = await w.message(w.halden.id, "TICKET", `2026-10-${10 + i}T10:00:00Z`);
      await w.x(w.halden.id, "MESSAGE", m.id, "THEME", `quote ${i}`, { theme: "csv_export" });
    }
    const all = await getSentiment(w.actor, { asOf: ASOF });
    expect(all.themes[0]!.quotes.length).toBeLessThanOrEqual(3);
    expect(all.themes[0]!.count).toBe(6);
    const one = await getSentiment(w.actor, { asOf: ASOF, theme: "csv_export" });
    expect(one.themes).toHaveLength(1);
    expect(one.themes[0]!.quotes).toHaveLength(6);
  });

  it("scopes to one account, to a CSM's book, and never reads another workspace", async () => {
    const w = await world("SentScope");
    const a = await w.message(w.halden.id, "TICKET", "2026-10-30T10:00:00Z");
    const b = await w.message(w.north.id, "TICKET", "2026-10-30T10:00:00Z");
    await w.x(w.halden.id, "MESSAGE", a.m.id, "THEME", "h", { theme: "billing" });
    await w.x(w.north.id, "MESSAGE", b.m.id, "THEME", "n", { theme: "billing" });
    expect((await getSentiment(w.actor, { asOf: ASOF })).themes[0]!.accounts).toBe(2);
    expect(
      (await getSentiment(w.actor, { asOf: ASOF, accountId: w.halden.id })).themes[0]!.accounts,
    ).toBe(1);
    await w.db.account.update({ where: { id: w.north.id }, data: { ownerMembershipId: null } });
    const csm = { ...w.actor, role: "CSM" as const, bookScope: "OWN" as const };
    expect((await getSentiment(csm, { asOf: ASOF })).themes[0]!.accounts).toBe(1);
    expect(
      (await getSentiment((await world("SentStranger")).actor, { asOf: ASOF })).themes,
    ).toEqual([]);
  });

  it("says nothing when nothing was read (no invented tone)", async () => {
    const w = await world("SentEmpty");
    const s = await getSentiment(w.actor, { asOf: ASOF });
    expect(s.mix.total).toBe(0);
    expect(s.themes).toEqual([]);
  });

  it("reads a fixed number of times for 2 accounts and for 5 (no N+1)", async () => {
    const w = await world("SentBudget");
    for (const a of [w.halden, w.north]) {
      const { m } = await w.message(a.id, "TICKET", "2026-10-30T10:00:00Z");
      await w.x(a.id, "MESSAGE", m.id, "THEME", "q", { theme: "billing" });
    }
    const two = await countQueries(() => getSentiment(w.actor, { asOf: ASOF }));
    for (let i = 0; i < 3; i++) {
      const a = await w.db.account.create({
        data: {
          workspaceId: w.ws,
          name: `X${i}`,
          tier: "MID_TOUCH",
          ownerMembershipId: w.actor.membershipId,
        },
      });
      const { m } = await w.message(a.id, "TICKET", "2026-10-30T10:00:00Z");
      await w.x(a.id, "MESSAGE", m.id, "THEME", "q", { theme: "billing" });
      await w.x(a.id, "MESSAGE", m.id, "SENTIMENT", "s", { label: "NEGATIVE" });
    }
    const five = await countQueries(() => getSentiment(w.actor, { asOf: ASOF }));
    expect(five.result.themes[0]!.accounts).toBe(5);
    expect(five.queries).toBe(two.queries);
  });
});
