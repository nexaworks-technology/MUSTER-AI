import { addDays, daysBetween } from "@/lib/dates";
import { applyCurve } from "../curves";
import { num, plural, round4 } from "../format";
import type { AccountBundle, ComponentEnv, ComponentResult, PillarComponents } from "../types";

/**
 * Support (ARCHITECTURE §4.1). No ticket data in the workspace = no data. An account with no
 * tickets in a workspace that has them scores on real evidence: the empty ticket window.
 */
const missing = (component: string, input: string, message: string): ComponentResult => ({
  score: null,
  reason: { component, kind: "MISSING_DATA", input, message, sources: [] },
});
const NO_TICKETS = "No support ticket data.";

const openOn = (b: AccountBundle) =>
  b.tickets.filter(
    (t) => t.openedDate <= b.asOf && (t.closedDate === null || t.closedDate > b.asOf),
  );

const emptyWindow = (b: AccountBundle) => ({
  sourceType: "Ticket",
  accountId: b.accountId,
  from: addDays(b.asOf, -89),
  to: b.asOf,
});

function openHigh(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "open_high";
  const I = "open_high_urgent_tickets";
  if (!b.workspaceHasTickets) return missing(C, I, NO_TICKETS);
  const high = openOn(b).filter((t) => t.priority === "HIGH" || t.priority === "URGENT");
  return {
    score: applyCurve(env.curve!, high.length),
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message: high.length
        ? `${plural(high.length, "high or urgent ticket")} ${high.length === 1 ? "is" : "are"} open.`
        : "No high or urgent tickets are open.",
      value: high.length,
      periodEnd: b.asOf,
      sources: high.length
        ? high.map((t) => ({ sourceType: "Ticket", sourceId: t.id }))
        : [emptyWindow(b)],
    },
  };
}

function oldestOpenVsTarget(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "oldest_open_vs_target";
  const I = "oldest_open_ticket_age_vs_target";
  if (!b.workspaceHasTickets) return missing(C, I, NO_TICKETS);
  const targets = env.params.ticketTargetDays;
  const scored = openOn(b)
    .map((t) => {
      const age = daysBetween(t.openedDate, b.asOf);
      return { t, age, target: targets[t.priority], ratio: age / targets[t.priority] };
    })
    .sort((x, y) => y.ratio - x.ratio || (x.t.id < y.t.id ? -1 : 1));
  const worst = scored[0];
  if (!worst)
    return {
      score: 100,
      reason: {
        component: C,
        kind: "EVIDENCE",
        input: I,
        message: "No tickets are open.",
        value: 0,
        periodEnd: b.asOf,
        sources: [emptyWindow(b)],
      },
    };
  return {
    score: applyCurve(env.curve!, worst.ratio),
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message: `Oldest open ticket "${worst.t.subject}" (${worst.t.priority.toLowerCase()}) has been open ${plural(worst.age, "day")}; the target is ${num(worst.target)}.`,
      value: worst.age,
      baseline: worst.target,
      delta: worst.age - worst.target,
      periodStart: worst.t.openedDate,
      periodEnd: b.asOf,
      sources: [{ sourceType: "Ticket", sourceId: worst.t.id }],
    },
  };
}

function escalations30d(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "escalations_30d";
  const I = "escalations_30d";
  if (!b.workspaceHasTickets) return missing(C, I, NO_TICKETS);
  const from = addDays(b.asOf, -29);
  const esc = b.tickets.filter(
    (t) => t.escalatedDate !== null && t.escalatedDate >= from && t.escalatedDate <= b.asOf,
  );
  return {
    score: applyCurve(env.curve!, esc.length),
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message: esc.length
        ? `${plural(esc.length, "ticket")} ${esc.length === 1 ? "was" : "were"} escalated in the last 30 days.`
        : "No tickets were escalated in the last 30 days.",
      value: round4(esc.length),
      periodStart: from,
      periodEnd: b.asOf,
      sources: esc.length
        ? esc.map((t) => ({ sourceType: "Ticket", sourceId: t.id }))
        : [{ sourceType: "Ticket", accountId: b.accountId, from, to: b.asOf }],
    },
  };
}

export const SUPPORT: PillarComponents = {
  open_high: openHigh,
  oldest_open_vs_target: oldestOpenVsTarget,
  escalations_30d: escalations30d,
  repeat_problem: () =>
    missing(
      "repeat_problem",
      "repeat_problems_30d",
      "Repeat problems need text analysis of tickets, which is not switched on yet.",
    ),
  ticket_sentiment: () =>
    missing(
      "ticket_sentiment",
      "negative_ticket_share",
      "Ticket sentiment needs text analysis, which is not switched on yet.",
    ),
};
