import { describe, expect, it } from "vitest";
import { scopedDb } from "@/lib/db/scoped";
import { createTestAdmin } from "@/test/fixtures";
import { countQueries } from "@/test/query-counter";
import {
  createPromise,
  listPromises,
  markPromiseKeptWithNote,
  PromiseInputError,
  setPromiseOwner,
} from "../service";

/**
 * The Promise Tracker's reads and the three things a person can do (M9 B3, Rules 2, 4): add a
 * promise by hand, give it an owner, say how it was kept. Status stays the one function's.
 */
const TODAY = "2026-11-02";

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
  const row = (
    accountId: string,
    what: string,
    o: {
      due?: string | null;
      owner?: string | null;
      status?: "OPEN" | "LATE" | "BROKEN" | "KEPT";
      party?: "US" | "CUSTOMER" | "UNCLEAR";
      quote?: string;
    } = {},
  ) =>
    db.promise.create({
      data: {
        workspaceId: ws,
        accountId,
        party: o.party ?? "US",
        what,
        dueDate: o.due ? new Date(`${o.due}T00:00:00Z`) : null,
        ownerMembershipId: o.owner ?? null,
        status: o.status ?? "OPEN",
        statusReason: "r",
        dedupeKey: `${what}-${Math.random()}`,
        origin: "HUMAN",
        ...(o.status === "KEPT"
          ? { keptAt: new Date("2026-10-30"), evidenceType: "Note", evidenceId: "n" }
          : {}),
        ...(o.quote
          ? { quote: o.quote, sourceType: "CALL_TRANSCRIPT" as const, sourceId: "t1" }
          : {}),
      },
    });
  return { actor, db, ws, halden, north, row };
}

describe("listPromises", () => {
  it("late first, then no owner, then due date; kept last; each row carries its quote, source and reason", async () => {
    const w = await world("PromList");
    await w.row(w.halden.id, "open-owned", { due: "2026-11-20", owner: w.actor.membershipId });
    await w.row(w.halden.id, "open-no-owner", { due: "2026-11-10" });
    await w.row(w.halden.id, "late-halden", {
      due: "2026-10-24",
      status: "LATE",
      owner: w.actor.membershipId,
      quote: "Engineering will have the CSV export fix to you by October 24.",
    });
    await w.row(w.north.id, "broken", { due: "2026-10-01", status: "BROKEN" });
    await w.row(w.north.id, "kept", { due: "2026-10-20", status: "KEPT" });
    const { rows } = await listPromises(w.actor, {});
    expect(rows.map((r) => r.what)).toEqual([
      "broken",
      "late-halden",
      "open-no-owner",
      "open-owned",
    ]);
    const late = rows.find((r) => r.what === "late-halden")!;
    expect(late).toMatchObject({
      account: { name: "Halden Retail" },
      status: "LATE",
      party: "US",
      quote: "Engineering will have the CSV export fix to you by October 24.",
      source: { type: "CALL_TRANSCRIPT", id: "t1" },
      dueDate: "2026-10-24",
      owner: { name: expect.any(String) },
    });
    expect((await listPromises(w.actor, { status: "ALL" })).rows.map((r) => r.what)).toContain(
      "kept",
    );
    expect(
      (await listPromises(w.actor, { accountId: w.north.id })).rows.map((r) => r.what),
    ).toEqual(["broken"]);
  });

  it("a CSM sees only their book; another workspace's promises never appear", async () => {
    const w = await world("PromBook");
    const other = await w.db.account.create({
      data: { workspaceId: w.ws, name: "Not mine", tier: "MID_TOUCH" },
    });
    await w.row(w.halden.id, "mine");
    await w.row(other.id, "not-mine");
    const csm = { ...w.actor, role: "CSM" as const, bookScope: "OWN" as const };
    expect((await listPromises(csm, {})).rows.map((r) => r.what)).toEqual(["mine"]);
    expect((await listPromises((await world("PromStranger")).actor, {})).rows).toHaveLength(0);
  });

  it("reads a fixed number of times for 2 accounts and for 5 (no N+1)", async () => {
    const w = await world("PromBudget");
    await w.row(w.halden.id, "a", { owner: w.actor.membershipId });
    await w.row(w.north.id, "b", { owner: w.actor.membershipId });
    const two = await countQueries(() => listPromises(w.actor, {}));
    for (let i = 0; i < 3; i++) {
      const a = await w.db.account.create({
        data: {
          workspaceId: w.ws,
          name: `X${i}`,
          tier: "MID_TOUCH",
          ownerMembershipId: w.actor.membershipId,
        },
      });
      await w.row(a.id, `x${i}`, { owner: w.actor.membershipId });
    }
    const five = await countQueries(() => listPromises(w.actor, {}));
    expect(five.result.rows).toHaveLength(5);
    expect(five.queries).toBe(two.queries);
  });
});

describe("createPromise (manual entry)", () => {
  it("makes a human-origin promise with no invented quote, a computed status, an owner, and an audit row", async () => {
    const w = await world("PromCreate");
    const p = await createPromise(w.actor, {
      accountId: w.halden.id,
      what: "Send the SSO guide",
      party: "US",
      dueDate: "2026-10-30",
      ownerMembershipId: w.actor.membershipId,
      today: TODAY,
    });
    const row = await w.db.promise.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({
      origin: "HUMAN",
      party: "US",
      status: "LATE",
      quote: null,
      sourceType: null,
      ownerMembershipId: w.actor.membershipId,
      createdByMembershipId: w.actor.membershipId,
    });
    expect(row.statusReason).toMatch(/3 days late/);
    expect(
      await w.db.auditLog.count({ where: { action: "promise.created", targetId: p.id } }),
    ).toBe(1);
  });

  it("refuses a missing what, an impossible date, an unknown owner and an account outside the book", async () => {
    const w = await world("PromCreateBad");
    const base = { accountId: w.halden.id, what: "x", party: "US" as const, today: TODAY };
    await expect(createPromise(w.actor, { ...base, what: "  " })).rejects.toBeInstanceOf(
      PromiseInputError,
    );
    await expect(createPromise(w.actor, { ...base, dueDate: "2026-02-31" })).rejects.toBeInstanceOf(
      PromiseInputError,
    );
    await expect(
      createPromise(w.actor, { ...base, ownerMembershipId: "nobody" }),
    ).rejects.toBeInstanceOf(PromiseInputError);
    const other = await w.db.account.create({
      data: { workspaceId: w.ws, name: "Not mine", tier: "MID_TOUCH" },
    });
    const csm = { ...w.actor, role: "CSM" as const, bookScope: "OWN" as const };
    await expect(createPromise(csm, { ...base, accountId: other.id })).rejects.toBeInstanceOf(
      PromiseInputError,
    );
  });
});

describe("setPromiseOwner", () => {
  it("assigns and clears an owner, audited; refuses a non-member; a viewer cannot", async () => {
    const w = await world("PromOwner");
    const p = await w.row(w.halden.id, "x", { due: "2026-11-05" });
    await setPromiseOwner(w.actor, { promiseId: p.id, ownerMembershipId: w.actor.membershipId });
    expect((await w.db.promise.findUniqueOrThrow({ where: { id: p.id } })).ownerMembershipId).toBe(
      w.actor.membershipId,
    );
    await setPromiseOwner(w.actor, { promiseId: p.id, ownerMembershipId: null });
    expect(
      (await w.db.promise.findUniqueOrThrow({ where: { id: p.id } })).ownerMembershipId,
    ).toBeNull();
    expect(
      await w.db.auditLog.count({ where: { action: "promise.owner_set", targetId: p.id } }),
    ).toBe(2);
    await expect(
      setPromiseOwner(w.actor, { promiseId: p.id, ownerMembershipId: "nobody" }),
    ).rejects.toBeInstanceOf(PromiseInputError);
    await expect(
      setPromiseOwner(
        { ...w.actor, role: "VIEWER" as const },
        { promiseId: p.id, ownerMembershipId: null },
      ),
    ).rejects.toThrow();
  });
});

describe("markPromiseKeptWithNote", () => {
  it("records how it was kept as a note on the account and uses that note as the evidence", async () => {
    const w = await world("PromKept");
    const p = await w.row(w.halden.id, "x", { due: "2026-10-24", status: "LATE" });
    await markPromiseKeptWithNote(w.actor, {
      promiseId: p.id,
      text: "Shipped the fix on the 29th; Elena confirmed on the call.",
      today: TODAY,
    });
    const row = await w.db.promise.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({ status: "KEPT", evidenceType: "Note" });
    const note = await w.db.note.findUniqueOrThrow({ where: { id: row.evidenceId! } });
    expect(note).toMatchObject({
      accountId: w.halden.id,
      origin: "HUMAN",
      body: "Shipped the fix on the 29th; Elena confirmed on the call.",
    });
    await expect(
      markPromiseKeptWithNote(w.actor, { promiseId: p.id, text: "  ", today: TODAY }),
    ).rejects.toBeInstanceOf(PromiseInputError);
  });
});
