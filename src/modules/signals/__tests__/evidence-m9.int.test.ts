import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { listAccountSignals } from "../service";

/** M9 B3: a promise, call or note in a signal's evidence opens its record, and a quote shows beside it. */
describe("signal evidence for M9 sources", () => {
  it("links Promise, CallTranscript and Note evidence and shows the quote", async () => {
    const { actor } = await createTestAdmin("EvidenceM9");
    const db = scopedDb(actor);
    const ws = actor.workspaceId;
    const account = await db.account.create({ data: { workspaceId: ws, name: "Halden", tier: "MID_TOUCH", ownerMembershipId: actor.membershipId } });
    await db.signal.create({
      data: {
        workspaceId: ws, accountId: account.id, ruleKey: "competitor_mentioned", ruleVersion: 1, category: "CALLS_EMAIL", severity: "WARN", polarity: "RISK",
        status: "OPEN", title: "Tallyfield mentioned", explanation: "x", values: {}, params: {}, dedupeKey: "k", episode: 1, firstSeenAt: new Date(), lastSeenAt: new Date(),
        evidence: [
          { sourceType: "CallTranscript", sourceId: "t1", value: "Our CFO asked us to look at Tallyfield before renewal.", date: "2026-10-21" },
          { sourceType: "Promise", sourceId: "p1", value: 9, date: "2026-10-24" },
          { sourceType: "Note", sourceId: "n1", value: "CRM deal notes", date: "2026-10-28" },
        ],
      },
    });
    const res = await listAccountSignals(actor, account.id);
    const links = res!.signals[0]!.evidenceLinks;
    expect(links[0]).toMatchObject({ href: `/accounts/${account.id}/conversations`, missing: false });
    expect(links[0]!.label).toContain("“Our CFO asked us to look at Tallyfield before renewal.”");
    expect(links[1]).toMatchObject({ href: `/accounts/${account.id}/promises#promise-p1`, label: "Promise" });
    expect(links[2]!.href).toBe(`/accounts/${account.id}/notes`);
  });
});
