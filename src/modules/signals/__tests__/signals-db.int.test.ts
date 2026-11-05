import { beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { RULES } from "../rules/catalog";
import { syncSignalRules } from "../service";

/** Signals are records the database keeps honest (M3 rule 8, D-57, D-61, INTERP-6). */
let db: ReturnType<typeof scopedDb>;
let ws: string;
let accountId: string;
let n = 0;

beforeAll(async () => {
  const { actor } = await createTestAdmin("SignalsDb");
  ws = actor.workspaceId;
  db = scopedDb(actor);
  accountId = (
    await db.account.create({ data: { workspaceId: ws, name: "Sig", tier: "MID_TOUCH" } })
  ).id;
});

const signal = (
  o: Partial<Prisma.SignalUncheckedCreateInput> = {},
): Prisma.SignalUncheckedCreateInput => ({
  workspaceId: ws,
  accountId,
  ruleKey: "usage_drop_vs_normal",
  ruleVersion: 1,
  category: "USAGE",
  severity: "WARN",
  polarity: "RISK",
  title: "Usage drop",
  explanation: "x",
  evidence: [
    { sourceType: "UsageDaily", accountId, from: "2026-10-01", to: "2026-10-31", value: 0.4 },
  ],
  values: {},
  params: {},
  dedupeKey: `k${++n}`,
  firstSeenAt: new Date("2026-11-02"),
  lastSeenAt: new Date("2026-11-02"),
  ...o,
});

describe("signal records", () => {
  it("refuse a signal without evidence", async () => {
    await expect(db.signal.create({ data: signal({ evidence: [] }) })).rejects.toThrow(
      /evidence_required/,
    );
  });

  it("refuse an outside signal without a public source URL and date", async () => {
    await expect(
      db.signal.create({ data: signal({ category: "OUTSIDE", ruleKey: "outside_event" }) }),
    ).rejects.toThrow(/outside_has_public_source/);
    await expect(
      db.signal.create({
        data: signal({
          category: "OUTSIDE",
          ruleKey: "outside_event",
          publicSourceUrl: "https://news.example.test/x",
        }),
      }),
    ).rejects.toThrow(/outside_has_public_source/);
  });

  it("refuse an AI signal without its agent run (Rule 5)", async () => {
    await expect(db.signal.create({ data: signal({ origin: "AI" }) })).rejects.toThrow(
      /agent_run_required/,
    );
  });

  it("allow only one live episode per dedupe key; a new episode after resolution is fine", async () => {
    const first = await db.signal.create({ data: signal({ dedupeKey: "same" }) });
    await expect(
      db.signal.create({ data: signal({ dedupeKey: "same", episode: 2 }) }),
    ).rejects.toThrow();
    await db.signal.update({
      where: { id: first.id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    const second = await db.signal.create({ data: signal({ dedupeKey: "same", episode: 2 }) });
    expect(second.episode).toBe(2);
    await expect(
      db.signal.create({ data: signal({ dedupeKey: "same", episode: 2 }) }),
    ).rejects.toThrow();
  });
});

describe("signal rules per workspace", () => {
  it("seed one row per rule with the four spec fields, idempotently", async () => {
    await syncSignalRules({ workspaceId: ws });
    await syncSignalRules({ workspaceId: ws });
    const rows = await db.signalRule.findMany({ orderBy: { ruleKey: "asc" } });
    expect(rows.map((r) => r.ruleKey)).toEqual(RULES.map((r) => r.key).sort());
    for (const r of rows) {
      expect(
        r.meaning.length &&
          r.howDetected.length &&
          r.typicalLeadTime.length &&
          r.falseAlarmCauses.length,
      ).toBeTruthy();
    }
  });

  it("keep a dormant rule disabled — the database refuses to enable it (D-61)", async () => {
    // In M10, no_meeting_in_x_days woke on real meeting data (Decision 1).
    // Test the database constraint dormant_disabled holds when dormantReason is present.
    const rule = await db.signalRule.findFirstOrThrow();
    await db.signalRule.update({
      where: { id: rule.id },
      data: { enabled: false, dormantReason: "Test dormant reason" },
    });
    await expect(
      db.signalRule.update({ where: { id: rule.id }, data: { enabled: true } }),
    ).rejects.toThrow(/dormant_disabled/);
  });

  it("does not overwrite a workspace's edited thresholds on re-sync", async () => {
    const r = await db.signalRule.findFirstOrThrow({ where: { ruleKey: "invoice_late" } });
    await db.signalRule.update({
      where: { id: r.id },
      data: { params: { graceDays: 14, materialDays: 30 }, version: 2 },
    });
    await syncSignalRules({ workspaceId: ws });
    expect((await db.signalRule.findUniqueOrThrow({ where: { id: r.id } })).params).toEqual({
      graceDays: 14,
      materialDays: 30,
    });
  });
});
