import { describe, expect, it } from "vitest";
import { supportRiskReport, type SupportRiskInput } from "../support-risk";
import { everyFigureIsProven, fig } from "./helpers";

const H = 3_600_000;
const t0 = Date.parse("2026-10-10T00:00:00Z");
type T = SupportRiskInput["tickets"][number];
const ticket = (id: string, p: Partial<T>): T => ({
  id,
  accountId: `acc-${id}`,
  status: "OPEN",
  priority: "NORMAL",
  isEscalated: false,
  openedAt: new Date(t0),
  firstResponseAt: null,
  ...p,
});
const input: SupportRiskInput = {
  periodStart: "2026-10-01",
  periodEnd: "2026-10-20",
  query: "",
  tickets: [
    ticket("t1", { isEscalated: true, priority: "URGENT", firstResponseAt: new Date(t0 + 2 * H) }),
    ticket("t2", { priority: "HIGH", firstResponseAt: new Date(t0 + 6 * H) }),
    ticket("t3", { status: "SOLVED", firstResponseAt: new Date(t0 + 4 * H) }),
    ticket("t4", {}), // open, never answered
    ticket("t5", { openedAt: new Date("2026-09-01T00:00:00Z"), status: "PENDING" }), // before the period, still open
  ],
  signals: [
    { id: "g1", accountId: "acc-t1" },
    { id: "g2", accountId: "acc-t2" },
  ],
};

describe("support risk", () => {
  const r = supportRiskReport(input);

  it("counts tickets open now, including ones opened before the period", () => {
    expect(fig(r, "Tickets open now").sources.ids).toEqual(["t1", "t2", "t4", "t5"]);
  });

  it("counts opened in the period and escalated / high priority among the open", () => {
    expect(fig(r, "Tickets opened in the period").value).toBe(4);
    expect(fig(r, "Open and escalated").sources.ids).toEqual(["t1"]);
    expect(fig(r, "Open at high or urgent priority").sources.ids).toEqual(["t1", "t2"]);
  });

  it("median first response is over tickets that have one, in hours; unanswered are listed apart", () => {
    const f = fig(r, "Median first response");
    expect(f).toMatchObject({ value: 4, unit: "hours" });
    expect(f.sources.ids).toEqual(["t1", "t2", "t3"]);
    expect(fig(r, "Opened in the period and not yet answered").sources.ids).toEqual(["t4"]);
  });

  it("names the accounts with open support signals", () => {
    expect(fig(r, "Accounts with an open support signal").sources.ids).toEqual([
      "acc-t1",
      "acc-t2",
    ]);
  });

  it("no tickets in scope says so instead of showing zeros for response time", () => {
    const e = supportRiskReport({ ...input, tickets: [], signals: [] });
    expect(fig(e, "Median first response").value).toBeNull();
    expect(fig(e, "Median first response").reason).toMatch(/No ticket/);
  });

  it("every figure is proven", () => everyFigureIsProven(r));
});
