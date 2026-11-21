import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { ingestBatch, type IngestTarget } from "../ingest.service";

/**
 * DEMO-WALKTHROUGH FAIL 43: ticket ingest never set `Ticket.firstResponseAt`, so the digest and the
 * Support risk report called answered tickets unanswered. It is the first reply on the ticket that
 * is not the requester's (the adapters mark those OUTBOUND), for every support connector that
 * carries replies (Zendesk, Freshdesk: the shared ticket ingest).
 */
async function setup(label: string, provider: "ZENDESK" | "FRESHDESK") {
  const { actor } = await createTestAdmin(label);
  const db = scopedDb(actor);
  const integration = await db.integration.create({
    data: { workspaceId: actor.workspaceId, provider },
  });
  const account = await db.account.create({
    data: {
      workspaceId: actor.workspaceId,
      name: `${label} Co`,
      tier: "MID_TOUCH",
      domain: `${label.toLowerCase()}.test`,
    },
  });
  await db.contact.create({
    data: {
      workspaceId: actor.workspaceId,
      accountId: account.id,
      name: "Req",
      email: `req@${label.toLowerCase()}.test`,
    },
  });
  const target: IngestTarget = {
    workspaceId: actor.workspaceId,
    integrationId: integration.id,
    source: provider,
  };
  return { db, target, requester: `req@${label.toLowerCase()}.test` };
}

const at = (h: number) => new Date(Date.UTC(2026, 10, 10, h));

const ticket = (requester: string, messages: Array<Record<string, unknown>>) => ({
  externalId: "t-1",
  subject: "Exports failing",
  requesterEmail: requester,
  openedAt: at(9),
  messages,
});

describe.each(["ZENDESK", "FRESHDESK"] as const)("first response at ingest (%s)", (provider) => {
  it("is the first reply that is not the requester's", async () => {
    const w = await setup(`FirstResp${provider}`, provider);
    await ingestBatch(w.target, {
      kind: "tickets",
      records: [
        ticket(w.requester, [
          {
            externalId: "m1",
            direction: "INBOUND",
            fromAddress: w.requester,
            bodyText: "Help",
            sentAt: at(9),
          },
          {
            externalId: "m2",
            direction: "INBOUND",
            fromAddress: w.requester,
            bodyText: "Any news?",
            sentAt: at(10),
          },
          {
            externalId: "m3",
            direction: "OUTBOUND",
            fromAddress: "agent@vendor.test",
            bodyText: "On it",
            sentAt: at(12),
          },
          {
            externalId: "m4",
            direction: "OUTBOUND",
            fromAddress: "agent@vendor.test",
            bodyText: "Fixed",
            sentAt: at(15),
          },
        ]),
      ],
    });
    const t = await w.db.ticket.findFirstOrThrow();
    expect(t.firstResponseAt).toEqual(at(12));
  });

  it("stays empty while only the requester has written: never guessed", async () => {
    const w = await setup(`NoResp${provider}`, provider);
    await ingestBatch(w.target, {
      kind: "tickets",
      records: [
        ticket(w.requester, [
          {
            externalId: "m1",
            direction: "INBOUND",
            fromAddress: w.requester,
            bodyText: "Help",
            sentAt: at(9),
          },
        ]),
      ],
    });
    expect((await w.db.ticket.findFirstOrThrow()).firstResponseAt).toBeNull();
  });

  it("a later sync that brings the first reply sets it, and a re-sync of a known ticket backfills it", async () => {
    const w = await setup(`LaterResp${provider}`, provider);
    const opening = {
      externalId: "m1",
      direction: "INBOUND",
      fromAddress: w.requester,
      bodyText: "Help",
      sentAt: at(9),
    };
    await ingestBatch(w.target, { kind: "tickets", records: [ticket(w.requester, [opening])] });
    const reply = { externalId: "m2", direction: "OUTBOUND", bodyText: "On it", sentAt: at(11) };
    const r = await ingestBatch(w.target, {
      kind: "tickets",
      records: [ticket(w.requester, [opening, reply])],
    });
    expect(r.counts.updated).toBe(1);
    const t = await w.db.ticket.findFirstOrThrow();
    expect(t.firstResponseAt).toEqual(at(11));
    // Already known messages (ingested before this fix): the re-sync still records the response.
    await w.db.ticket.update({ where: { id: t.id }, data: { firstResponseAt: null } });
    await ingestBatch(w.target, {
      kind: "tickets",
      records: [ticket(w.requester, [opening, reply])],
    });
    expect((await w.db.ticket.findFirstOrThrow()).firstResponseAt).toEqual(at(11));
    // And once set, a re-sync changes nothing.
    const again = await ingestBatch(w.target, {
      kind: "tickets",
      records: [ticket(w.requester, [opening, reply])],
    });
    expect(again.counts).toMatchObject({ updated: 0, unchanged: 1 });
  });
});
