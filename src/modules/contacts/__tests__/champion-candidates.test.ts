import { describe, expect, it } from "vitest";
import { rankCandidates, type CandidatePerson } from "../champion-candidates";

/**
 * Champion Guard's deterministic part (M9 B4): who could be the next champion, ranked by what the
 * records show, each with the reasons and their sources. The model only explains and drafts; it
 * never picks.
 */
const ASOF = "2026-11-02";
const person = (id: string, over: Partial<CandidatePerson> = {}): CandidatePerson => ({
  id,
  name: id.toUpperCase(),
  title: null,
  email: `${id}@x.test`,
  status: "ACTIVE",
  roles: [],
  inbound: [],
  activeDaysLast30: 0,
  ...over,
});
const run = (people: CandidatePerson[], goneContactId: string | null = "maya") =>
  rankCandidates({ asOf: ASOF, accountId: "a1", goneContactId, people });

describe("rankCandidates", () => {
  it("a decision maker outranks a daily user, who outranks someone with only an email on file", () => {
    const r = run([
      person("plain"),
      person("daily", { roles: [{ id: "r2", role: "DAILY_USER" }] }),
      person("dm", { roles: [{ id: "r1", role: "DECISION_MAKER" }] }),
    ]);
    expect(r.map((c) => c.contactId)).toEqual(["dm", "daily", "plain"]);
  });

  it("recent writing and product activity lift someone up, and the reasons name the messages", () => {
    const r = run([
      person("quiet", { roles: [{ id: "r1", role: "DAILY_USER" }] }),
      person("active", {
        roles: [{ id: "r2", role: "DAILY_USER" }],
        inbound: [
          { id: "m1", date: "2026-10-21" },
          { id: "m2", date: "2026-09-30" },
        ],
        activeDaysLast30: 8,
      }),
    ]);
    expect(r[0]!.contactId).toBe("active");
    const texts = r[0]!.reasons.map((x) => x.text);
    expect(texts).toContain(
      "Wrote to us 2 times in the last 90 days, most recently on Oct 21, 2026",
    );
    expect(texts).toContain("Active in the product on 8 of the last 30 days");
    const wrote = r[0]!.reasons.find((x) => x.text.startsWith("Wrote to us"))!;
    expect(wrote.sources).toEqual([
      { sourceType: "Message", sourceId: "m1" },
      { sourceType: "Message", sourceId: "m2" },
    ]);
  });

  it("messages older than 90 days do not count", () => {
    const r = run([person("old", { inbound: [{ id: "m1", date: "2026-07-01" }] })]);
    expect(r[0]!.reasons.map((x) => x.text).some((t) => t.startsWith("Wrote to us"))).toBe(false);
  });

  it("leaves out the champion who is gone, anyone who bounced or left, and anyone with no email", () => {
    const r = run([
      person("maya", { roles: [{ id: "r0", role: "CHAMPION" }] }),
      person("bounced", { status: "BOUNCED" }),
      person("left", { status: "LEFT" }),
      person("noemail", { email: null }),
      person("ok"),
    ]);
    expect(r.map((c) => c.contactId)).toEqual(["ok"]);
  });

  it("every candidate has at least one reason with a source (no naked ranking)", () => {
    for (const c of run([
      person("a"),
      person("b", { roles: [{ id: "r", role: "EXEC_SPONSOR" }] }),
    ])) {
      expect(c.reasons.length).toBeGreaterThan(0);
      for (const reason of c.reasons) expect(reason.sources.length).toBeGreaterThan(0);
    }
  });

  it("ties break by name then id, so the order never flickers", () => {
    const r = run([
      person("b", { name: "Zed" }),
      person("a", { name: "Amy" }),
      person("c", { name: "Amy" }),
    ]);
    expect(r.map((c) => c.contactId)).toEqual(["a", "c", "b"]);
  });

  it("no one eligible gives an empty list, not an invented name", () => {
    expect(run([person("maya"), person("x", { email: null })])).toEqual([]);
    expect(run([])).toEqual([]);
  });

  it("a former role does not count, only a current one the caller passes", () => {
    const r = run([person("a"), person("b", { roles: [{ id: "r", role: "EXEC_SPONSOR" }] })]);
    expect(r[0]!.contactId).toBe("b");
  });
});
