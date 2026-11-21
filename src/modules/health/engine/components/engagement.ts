import { addDays, daysBetween } from "@/lib/dates";
import { applyCurve } from "../curves";
import { day, num, pct, plural, round4 } from "../format";
import type { AccountBundle, ComponentEnv, ComponentResult, PillarComponents } from "../types";
import { currentChampion } from "./people";
import { median } from "../windows";

/** Engagement (ARCHITECTURE §4.1): two-way conversation, reply rate, champion activity. */
const missing = (component: string, input: string, message: string): ComponentResult => ({
  score: null,
  reason: { component, kind: "MISSING_DATA", input, message, sources: [] },
});

const TALK = new Set(["EMAIL", "CHAT", "CALL"]);

function conversational(b: AccountBundle) {
  return (b.messages ?? []).filter((m) => m.date <= b.asOf && TALK.has(m.channel));
}

function lastCustomerReply(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "last_customer_reply";
  const I = "days_since_customer_reply";
  const msgs = conversational(b);
  if (msgs.length === 0) return missing(C, I, "No email, chat or call history.");
  const ours = new Set(msgs.filter((m) => m.direction === "OUTBOUND").map((m) => m.conversationId));
  const replies = msgs
    .filter((m) => m.direction === "INBOUND" && !m.isBounce && ours.has(m.conversationId))
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.id < y.id ? -1 : 1));
  const last = replies.at(-1);
  if (!last) {
    const sent = msgs
      .filter((m) => m.direction === "OUTBOUND")
      .sort((x, y) => (x.date < y.date ? -1 : 1));
    return {
      score: 0,
      reason: {
        component: C,
        kind: "EVIDENCE",
        input: I,
        message: `No reply from the customer on record (${plural(sent.length, "message")} sent since ${day(sent[0]!.date)}).`,
        value: null,
        sources: sent.slice(-20).map((m) => ({ sourceType: "Message", sourceId: m.id })),
      },
    };
  }
  const days = daysBetween(last.date, b.asOf);
  return {
    score: applyCurve(env.curve!, days),
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message: `The customer last wrote back ${plural(days, "day")} ago (${day(last.date)}).`,
      value: days,
      periodStart: last.date,
      periodEnd: b.asOf,
      sources: [{ sourceType: "Message", sourceId: last.id }],
    },
  };
}

/**
 * Not scored: the model has no curve for meeting recency (`model.ts`), and choosing one is a
 * product decision (docs/QUESTIONS.md). The reason says so instead of claiming meeting data is
 * missing, which was false with a calendar connected (DEMO-WALKTHROUGH FAIL 9). Null, so it never
 * lowers a score (Rule 4).
 */
function lastMeeting(): ComponentResult {
  return missing(
    "last_meeting",
    "days_since_meeting",
    "Not scored: this health model has no rule yet for how recent a meeting should be, so meetings neither raise nor lower the score. The account's meetings are on its Timeline.",
  );
}

function replyRate(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "reply_rate";
  const I = "email_reply_rate_90d";
  if (b.messages === null) return missing(C, I, "No email history.");
  const from = addDays(b.asOf, -103);
  const to = addDays(b.asOf, -14);
  const emails = (b.messages ?? []).filter((m) => m.channel === "EMAIL" && m.date <= b.asOf);
  const sent = emails.filter((m) => m.direction === "OUTBOUND" && m.date >= from && m.date <= to);
  if (sent.length < 3)
    return missing(C, I, `Too few emails sent to judge the reply rate (${sent.length}; 3 needed).`);
  const replied = sent.filter((o) =>
    emails.some(
      (i) =>
        i.direction === "INBOUND" &&
        !i.isBounce &&
        i.conversationId === o.conversationId &&
        i.date >= o.date &&
        daysBetween(o.date, i.date) <= 14,
    ),
  ).length;
  const rate = replied / sent.length;
  return {
    score: applyCurve(env.curve!, rate),
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message: `${replied} of ${plural(sent.length, "email")} we sent got a reply within 14 days (${pct(rate)}).`,
      value: round4(rate),
      periodStart: from,
      periodEnd: to,
      sources: [{ sourceType: "Message", accountId: b.accountId, from, to }],
    },
  };
}

/** Quiet after max(21 days, 3 × the champion's own median gap) — M3 rule 7. */
function championActivity(b: AccountBundle, env: ComponentEnv): ComponentResult {
  const C = "champion_activity";
  const I = "days_since_champion_wrote";
  const champ = currentChampion(b);
  if (!champ) return missing(C, I, "No current champion.");
  const from = addDays(b.asOf, -180);
  const theirs = (b.messages ?? [])
    .filter(
      (m) =>
        m.direction === "INBOUND" &&
        !m.isBounce &&
        m.fromContactId === champ.contact.id &&
        m.date >= from &&
        m.date <= b.asOf,
    )
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.id < y.id ? -1 : 1));
  const dates = [...new Set(theirs.map((m) => m.date))];
  if (dates.length < 2)
    return missing(
      C,
      I,
      `Not enough messages from ${champ.contact.name} to know their usual rhythm (${dates.length}).`,
    );
  const cadence = median(dates.slice(1).map((d, i) => daysBetween(dates[i]!, d)))!;
  const limit = Math.max(
    env.params.championQuietMinDays,
    env.params.championQuietCadences * cadence,
  );
  const last = theirs.at(-1)!;
  const days = daysBetween(last.date, b.asOf);
  const score =
    days <= cadence
      ? 100
      : days <= limit
        ? 100 - (60 * (days - cadence)) / (limit - cadence)
        : Math.max(0, 40 * (1 - (days - limit) / limit));
  return {
    score,
    reason: {
      component: C,
      kind: "EVIDENCE",
      input: I,
      message: `${champ.contact.name} last wrote ${plural(days, "day")} ago; usually every ${plural(Number(num(cadence)), "day")} (quiet after ${num(limit)}).`,
      value: days,
      baseline: round4(cadence),
      delta: round4(days - cadence),
      periodStart: last.date,
      periodEnd: b.asOf,
      sources: [
        { sourceType: "Message", sourceId: last.id },
        { sourceType: "StakeholderRole", sourceId: champ.role.id },
      ],
    },
  };
}

export const ENGAGEMENT: PillarComponents = {
  last_customer_reply: lastCustomerReply,
  last_meeting: lastMeeting,
  reply_rate: replyRate,
  champion_activity: championActivity,
};
