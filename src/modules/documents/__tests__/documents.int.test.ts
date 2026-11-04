import { describe, expect, it } from "vitest";
import { addDays, businessClock, todayIn, utcMidnight } from "@/lib/dates";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import {
  createDocument,
  createRenewalBrief,
  DocumentError,
  getRenewalBrief,
  readDocument,
  updateNarrative,
} from "../service";

/**
 * M7 B3: documents with locked metrics. The database refuses a change to locked metrics; the
 * narrative is validated on every write (the same placeholder rule as the agent's); money metrics
 * read "Restricted" without revenue access; a brief is built from records by code; another
 * workspace's documents are unreachable.
 */
const TODAY = todayIn("UTC", businessClock);
const d = (n: number) => utcMidnight(addDays(TODAY, n));

async function world(label: string) {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const ws = actor.workspaceId;
  const account = await db.account.create({
    data: {
      workspaceId: ws,
      name: `${label} Freight`,
      tier: "MID_TOUCH",
      plan: "Growth",
      ownerMembershipId: actor.membershipId,
    },
  });
  const contract = await db.contract.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      startDate: d(-324),
      endDate: d(41),
      renewalDate: d(41),
      noticePeriodDays: 30,
      valueMinor: 14_200_000n,
      seatsPurchased: 10,
    },
  });
  const renewal = await db.renewal.create({
    data: {
      workspaceId: ws,
      accountId: account.id,
      contractId: contract.id,
      renewalDate: d(41),
      noticeDeadline: d(11),
      arrAtRiskMinor: 14_200_000n,
      currency: "USD",
      confidence: 70,
      confidenceBand: "HIGH",
      confidenceReasons: [],
      confidenceAsOf: d(0),
    },
  });
  return { actor, db, ws, account, contract, renewal };
}

describe("a renewal brief built from records", () => {
  it("locks the metrics at creation, points the renewal at it, and reads them back with sources", async () => {
    const w = await world("DocA");
    const doc = await createRenewalBrief(w.actor, w.renewal.id);
    expect(doc).toMatchObject({ kind: "RENEWAL_BRIEF", origin: "HUMAN" });
    expect(doc.lockedAt).not.toBeNull();
    expect(
      (await w.db.renewal.findUniqueOrThrow({ where: { id: w.renewal.id } })).briefDocumentId,
    ).toBe(doc.id);
    const page = await getRenewalBrief(w.actor, w.renewal.id);
    const m = Object.fromEntries(page.document!.metrics.map((x) => [x.key, x]));
    expect(m["renewal.daysTo"]!.text).toBe("41 days");
    expect(m["renewal.confidence"]!.text).toBe("70%");
    expect(m["renewal.arr"]!.text).toBe("$142,000.00");
    expect(m["health.band"]!.text).toBe("No health score on file");
    expect(m["goals.status"]!.text).toBe("No goals on file");
    expect(m["renewal.date"]!.sources).toContainEqual({
      sourceType: "Contract",
      sourceId: w.contract.id,
    });
  });

  it("without revenue access the money metrics read Restricted and no figure survives", async () => {
    const w = await world("DocB");
    const doc = await createRenewalBrief(w.actor, w.renewal.id);
    const v = await readDocument({ ...w.actor, canViewRevenue: false }, doc.id);
    expect(v.moneyVisible).toBe(false);
    const m = Object.fromEntries(v.metrics.map((x) => [x.key, x]));
    expect(m["renewal.arr"]).toMatchObject({ text: "Restricted", value: null });
    expect(m["expansion.estimate"]).toMatchObject({ text: "Restricted", value: null });
    expect(JSON.stringify(v)).not.toMatch(/142,000|14200000/);
    expect(m["renewal.confidence"]!.text).toBe("70%");
  });
});

describe("locked metrics", () => {
  it("the database refuses any change to locked metrics, and to the lock itself", async () => {
    const w = await world("DocLock");
    const doc = await createRenewalBrief(w.actor, w.renewal.id);
    await expect(
      w.db.document.update({ where: { id: doc.id }, data: { metrics: {} } }),
    ).rejects.toThrow(/locked/);
    await expect(
      w.db.document.update({ where: { id: doc.id }, data: { lockedAt: null } }),
    ).rejects.toThrow(/locked/);
    // The narrative is the editable part.
    await w.db.document.update({ where: { id: doc.id }, data: { title: "Renamed" } });
  });
});

describe("narrative edits", () => {
  it("accepts text whose numbers are placeholders and renders them from the locked metrics", async () => {
    const w = await world("DocNarr");
    const doc = await createRenewalBrief(w.actor, w.renewal.id);
    await updateNarrative(w.actor, doc.id, [
      {
        id: "a",
        type: "paragraph",
        text: "Renews on {{metric.renewal.date}} at {{metric.renewal.confidence}}.",
      },
    ]);
    const v = await readDocument(w.actor, doc.id);
    expect(v.rendered[0]!.text).toMatch(/^Renews on .+ at 70%\.$/);
    expect(
      await w.db.auditLog.count({
        where: { action: "document.narrative_edited", targetId: doc.id },
      }),
    ).toBe(1);
  });

  it("refuses a free-text number that matches a metric, an unknown placeholder, and leaves the stored narrative unchanged", async () => {
    const w = await world("DocBad");
    const doc = await createRenewalBrief(w.actor, w.renewal.id);
    const err = await updateNarrative(w.actor, doc.id, [
      { id: "a", type: "paragraph", text: "About 142,000 is at stake." },
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(DocumentError);
    expect(err.message).toContain("{{metric.renewal.arr}}");
    await expect(
      updateNarrative(w.actor, doc.id, [
        { id: "a", type: "paragraph", text: "{{metric.renewal.bonus}}" },
      ]),
    ).rejects.toBeInstanceOf(DocumentError);
    expect((await w.db.document.findUniqueOrThrow({ where: { id: doc.id } })).narrative).toEqual(
      [],
    );
  });

  it("creating a document with a bad narrative writes nothing", async () => {
    const w = await world("DocBadNew");
    await expect(
      createDocument(w.actor, {
        accountId: w.account.id,
        kind: "RENEWAL_BRIEF",
        title: "x",
        metrics: {},
        narrative: [{ id: "a", type: "paragraph", text: "41 days" }],
        origin: "SYSTEM",
      }),
    ).rejects.toBeInstanceOf(DocumentError);
    expect(await w.db.document.count()).toBe(0);
  });

  it("an AI document must name its run (Rule 5)", async () => {
    const w = await world("DocAi");
    await expect(
      createDocument(w.actor, {
        accountId: w.account.id,
        kind: "RENEWAL_BRIEF",
        title: "x",
        metrics: {},
        narrative: [],
        origin: "AI",
      }),
    ).rejects.toThrow();
  });
});

describe("tenant scoping", () => {
  it("another workspace cannot read or edit this workspace's document", async () => {
    const a = await world("DocIsoA");
    const b = await world("DocIsoB");
    const doc = await createRenewalBrief(a.actor, a.renewal.id);
    await expect(readDocument(b.actor, doc.id)).rejects.toBeInstanceOf(DocumentError);
    await expect(
      updateNarrative(b.actor, doc.id, [{ id: "a", type: "paragraph", text: "hello" }]),
    ).rejects.toBeInstanceOf(DocumentError);
    await expect(getRenewalBrief(b.actor, a.renewal.id)).rejects.toBeInstanceOf(DocumentError);
  });
});
