import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { ids } from "../demo/ids";
import { runSeed } from "../run";

/**
 * The M9 story data flows through the seed (A8): the REAL Watcher over recorded answers, promises
 * and goals from the extractions, the text and promise signals honestly firing, the inbox, and —
 * the founder's stop condition — no seeded health score, band, input hash or renewal confidence
 * moved from the M8 baseline (D4, risk 1).
 */
const BASELINE = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "fixtures", "m8-health-baseline.json"), "utf8"),
) as {
  snapshots: Array<Record<string, string | null>>;
  accounts: number;
  renewals: Array<{
    accountId: string;
    contractId: string;
    confidence: number;
    confidenceBand: string;
  }>;
};

let db: ReturnType<typeof scopedDb>;
let workspaceId: string;
const acct = (key: string) => ids.account(key);

beforeAll(async () => {
  const [ws] = await runSeed({ includeTestTenant: false });
  workspaceId = ws!.id;
  db = scopedDb({ workspaceId });
}, 600_000);

const open = (accountKey: string, ruleKey: string) =>
  db.signal.findMany({
    where: { accountId: acct(accountKey), ruleKey, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
  });

describe("seeded extractions (real Watcher, recorded answers)", () => {
  it("every story source was read once, and not one quote was dropped", async () => {
    const runs = await db.agentRun.findMany({
      where: { agentKey: "watcher", triggerType: "extraction", promptVersion: "1.1.0" },
    });
    expect(runs.length).toBe(13);
    expect(runs.every((r) => r.status === "SUCCEEDED")).toBe(true);
    expect(
      runs.filter((r) => JSON.stringify(r.effects).includes("DroppedExtraction")),
    ).toHaveLength(0);
    const rows = await db.extraction.findMany();
    expect(rows.every((r) => r.origin === "AI" && r.agentRunId && r.quote.length > 0)).toBe(true);
  });

  it("is idempotent: a second seed adds no runs, extractions, promises or goals", async () => {
    const count = async () => [
      await db.agentRun.count({ where: { agentKey: "watcher" } }),
      await db.extraction.count(),
      await db.promise.count(),
      await db.goal.count(),
    ];
    const before = await count();
    await runSeed({ includeTestTenant: false });
    expect(await count()).toEqual(before);
  }, 600_000);
});

describe("seeded promises and goals", () => {
  it("Halden's 'CSV export fix by October 24' is a late promise of ours, with its call quote", async () => {
    const p = await db.promise.findFirstOrThrow({ where: { accountId: acct("halden") } });
    expect(p).toMatchObject({
      party: "US",
      status: "LATE",
      sourceType: "CALL_TRANSCRIPT",
      quote: "Engineering will have the CSV export fix to you by October 24.",
      ownerMembershipId: null,
    });
    expect(p.dueDate?.toISOString().slice(0, 10)).toBe("2026-10-24");
    expect(p.statusReason).toMatch(/9 days late/);
  });

  it("Northgate has the late promise it was missing: 3 days late", async () => {
    const p = await db.promise.findFirstOrThrow({ where: { accountId: acct("northgate") } });
    expect(p).toMatchObject({
      party: "US",
      status: "LATE",
      quote: "We'll have the API limit increase live by October 30.",
    });
    expect(p.statusReason).toMatch(/3 days late/);
  });

  it("Saltmarsh's promised integration is a promise from a CRM note; who made it is not guessed", async () => {
    const p = await db.promise.findFirstOrThrow({ where: { accountId: acct("saltmarsh") } });
    expect(p).toMatchObject({
      party: "UNCLEAR",
      suggestedParty: "US",
      status: "OPEN",
      dueDate: null,
      sourceType: "NOTE",
    });
    expect(p.quote).toBe(
      "Sales promised a native Zendesk integration by the end of their first quarter.",
    );
  });

  it("Marlow & Finch's goal is an AI-origin goal with its call quote; Saltmarsh's human goals are untouched", async () => {
    const g = await db.goal.findFirstOrThrow({
      where: { accountId: acct("marlow-finch"), origin: "AI" },
    });
    expect(g).toMatchObject({
      text: "Cut month-end close to 3 days",
      quote: "Our goal is to cut month-end close to 3 days.",
      sourceType: "CALL_TRANSCRIPT",
    });
    expect(g.agentRunId).not.toBeNull();
    expect(await db.goal.count({ where: { accountId: acct("saltmarsh"), origin: "HUMAN" } })).toBe(
      2,
    );
    expect(await db.goal.count({ where: { accountId: acct("copperleaf"), origin: "AI" } })).toBe(1);
  });
});

describe("seeded signals fire honestly from the new records", () => {
  it("Brightwell: Tallyfield from the call is a WARN", async () => {
    const s = await open("brightwell", "competitor_mentioned");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ severity: "WARN", title: "Tallyfield mentioned" });
    expect(JSON.stringify(s[0]!.evidence)).toContain(
      "Our CFO asked us to look at Tallyfield before renewal.",
    );
  });
  it("Quillmark: cancel and export language, both critical", async () => {
    expect((await open("quillmark", "cancel_language"))[0]?.severity).toBe("CRITICAL");
    expect((await open("quillmark", "export_language"))[0]?.severity).toBe("CRITICAL");
  });
  it("Halden: the same CSV problem in 3 tickets", async () => {
    const s = await open("halden", "repeat_problem");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ severity: "WARN", title: "csv export problem in 3 tickets" });
    expect((await open("halden", "promise_late"))[0]).toMatchObject({ severity: "WARN" });
  });
  it("Northgate: renewal concern (critical, renewal in 41 days), budget, late promise, unowned promise", async () => {
    expect((await open("northgate", "renewal_concern"))[0]?.severity).toBe("CRITICAL");
    expect((await open("northgate", "budget_concern"))[0]?.severity).toBe("WARN");
    expect((await open("northgate", "promise_late"))[0]?.severity).toBe("WARN");
    expect(await open("northgate", "promise_no_owner")).toHaveLength(1);
  });
  it("Marlow & Finch: the stated goal is an info signal", async () => {
    expect((await open("marlow-finch", "goal_stated"))[0]).toMatchObject({ severity: "INFO" });
  });
  it("one angry email is not a pattern: no angry_sentiment signal anywhere in the seed", async () => {
    expect(await db.signal.count({ where: { ruleKey: "angry_sentiment" } })).toBe(0);
  });
});

describe("seeded inbox", () => {
  it("Halden's angry email and its three tickets are in the inbox; the bounce notice is not", async () => {
    const items = await db.inboxItem.findMany({ where: { accountId: acct("halden") } });
    expect(items.filter((i) => i.sourceType === "TICKET")).toHaveLength(3);
    expect(items.filter((i) => i.sourceType === "MESSAGE").length).toBeGreaterThanOrEqual(1);
    const bounce = await db.message.findFirstOrThrow({
      where: { fromAddress: { startsWith: "mailer-daemon@" } },
    });
    expect(await db.inboxItem.count({ where: { sourceId: bounce.id } })).toBe(0);
  });
  it("an email from an unknown domain waits in Unmatched with its text", async () => {
    const u = await db.unmatchedInbound.findFirstOrThrow({
      where: { externalId: "seed-unmatched-1" },
    });
    expect(u).toMatchObject({
      status: "PENDING",
      reason: "No contact or account uses unknown-finance.test.",
    });
    expect(u.bodyText).toContain("month-end reporting");
  });
});

describe("no seeded health number moved (D4: the founder's stop condition)", () => {
  // inputsHash is not compared to the baseline: two consecutive M9-free seeds already differ in 14 of
  // 60 hashes (clock-stamped contact and ticket dates, a property of the seed that predates M9). That M9
  // adds nothing to the hash is proved at its source in health/__tests__/sentiment-hash-m9.int.test.ts.
  it("every account's current snapshot matches the M8 baseline: overall, every pillar and the risk level", async () => {
    const snaps = await db.healthScoreSnapshot.findMany({
      where: { isBacktest: false },
      orderBy: [{ accountId: "asc" }, { asOf: "desc" }, { createdAt: "desc" }],
    });
    const latest = new Map<string, (typeof snaps)[number]>();
    for (const s of snaps) if (!latest.has(s.accountId)) latest.set(s.accountId, s);
    expect(await db.account.count()).toBe(BASELINE.accounts);
    expect(latest.size).toBe(BASELINE.snapshots.length);
    for (const b of BASELINE.snapshots) {
      const s = latest.get(b.accountId!)!;
      expect({
        accountId: s.accountId,
        asOf: s.asOf.toISOString().slice(0, 10),
        overall: s.overall?.toString() ?? null,
        adoption: s.adoption?.toString() ?? null,
        engagement: s.engagement?.toString() ?? null,
        support: s.support?.toString() ?? null,
        relationship: s.relationship?.toString() ?? null,
        commercial: s.commercial?.toString() ?? null,
        sentiment: s.sentiment?.toString() ?? null,
        riskLevel: s.riskLevel,
      }).toEqual(Object.fromEntries(Object.entries(b).filter(([k]) => k !== "inputsHash")));
    }
  });

  it("every renewal confidence and band is the M8 value, Northgate's 70 and the seven-way tie included", async () => {
    const renewals = await db.renewal.findMany({
      select: { accountId: true, contractId: true, confidence: true, confidenceBand: true },
      orderBy: [{ accountId: "asc" }, { contractId: "asc" }],
    });
    expect(renewals).toEqual(BASELINE.renewals);
    expect(renewals.find((r) => r.accountId === acct("northgate"))?.confidence).toBe(70);
  });

  it("by construction: no ticket-thread message carries a sentiment label (the only path into the health input)", async () => {
    expect(
      await db.message.count({
        where: { sentimentLabel: { not: null }, conversation: { channel: "TICKET" } },
      }),
    ).toBe(0);
    const email = await db.message.findMany({
      where: { sentimentLabel: { not: null } },
      select: { sentimentLabel: true },
    });
    expect(email.map((m) => m.sentimentLabel).sort()).toEqual(["NEGATIVE", "POSITIVE"]);
  });
});
