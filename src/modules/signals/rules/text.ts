import { daysBetween, type CalendarDate } from "@/lib/dates";
import { formatDay } from "@/modules/health/service";
import type { Evidence, EvalContext, SignalBundle, SignalCandidate } from "./index";
import type { ParamsOf } from "./catalog";

/**
 * The M9 text rules. Each reads verified extractions only (D-75, Rule 1): the label is the model's,
 * kept because its quote appears word for word in the source; the decision to raise a signal is
 * this code's. Evidence is the source record, the quote and the date, so a signal never shows a
 * claim without its proof. Pure functions of the bundle's `text` facts, like every other rule.
 */
export type TextKind =
  | "SENTIMENT"
  | "COMPETITOR"
  | "BUDGET_CONCERN"
  | "GOAL"
  | "CANCEL_LANGUAGE"
  | "EXPORT_LANGUAGE"
  | "COMPLAINT"
  | "RENEWAL_CONCERN"
  | "THEME"
  | "INTENT";

export interface TextFact {
  /** The Extraction row id. */
  id: string;
  kind: TextKind;
  sourceType: "MESSAGE" | "NOTE" | "CALL_TRANSCRIPT" | "TICKET" | "SURVEY_RESPONSE" | "FILE";
  sourceId: string;
  /** The day of the source record (business time zone), not of the extraction run. */
  date: CalendarDate;
  quote: string;
  /** The conversation's channel and id, for messages. */
  channel: "EMAIL" | "CALL" | "CHAT" | "TICKET" | "MEETING" | null;
  conversationId: string | null;
  direction: "INBOUND" | "OUTBOUND" | null;
  /** A theme from the fixed list (never `other`), or null. */
  theme: string | null;
  competitor: string | null;
  intent: string | null;
  label: "NEGATIVE" | "NEUTRAL" | "POSITIVE" | "MIXED" | null;
}

const SOURCE_NAME = {
  MESSAGE: "Message",
  NOTE: "Note",
  CALL_TRANSCRIPT: "CallTranscript",
  TICKET: "Ticket",
  SURVEY_RESPONSE: "SurveyResponse",
  FILE: "File",
} as const;

const word = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const MAX_EVIDENCE = 5;

/** The last `days` days ending on the as-of day (so a 30-day window is asOf and the 29 before). */
const within = (date: CalendarDate, asOf: CalendarDate, days: number) =>
  date <= asOf && daysBetween(date, asOf) < days;

const newestFirst = (a: TextFact, b: TextFact) =>
  a.date < b.date ? 1 : a.date > b.date ? -1 : a.id < b.id ? 1 : -1;

/** The facts as evidence: the source record, with the quote as its value and the source's day. */
function evidenceOf(facts: TextFact[]): Evidence[] {
  return [...facts]
    .sort(newestFirst)
    .slice(0, MAX_EVIDENCE)
    .map((f) => ({
      sourceType: SOURCE_NAME[f.sourceType],
      sourceId: f.sourceId,
      value: f.quote,
      date: f.date,
    }));
}

const recent = (b: SignalBundle, kind: TextKind, days: number) =>
  (b.text ?? []).filter((f) => f.kind === kind && within(f.date, b.asOf, days));

const quoted = (f: TextFact) => `“${f.quote}” (${formatDay(f.date)})`;

/** Count rules with fire/clear levels: the M3 hysteresis (a signal stays open until it clears). */
function level(
  open: boolean,
  count: number,
  p: { fire: number; clear: number; critical: number },
): "INFO" | "WARN" | "CRITICAL" | null {
  if (count < (open ? p.clear : p.fire)) return null;
  return count >= p.critical ? "CRITICAL" : "WARN";
}

const groupBy = <T>(xs: T[], key: (x: T) => string | null) => {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (k) m.set(k, [...(m.get(k) ?? []), x]);
  }
  return m;
};

const lower = (s: string) => s.trim().toLowerCase();

export const TEXT_EVALUATORS = {
  competitor_mentioned: (b: SignalBundle, p: ParamsOf<"competitor_mentioned">): SignalCandidate[] =>
    [
      ...groupBy(recent(b, "COMPETITOR", p.windowDays), (f) =>
        f.competitor ? lower(f.competitor) : null,
      ),
    ].map(([key, facts]) => {
      const name = [...facts].sort(newestFirst)[0]!.competitor!;
      return {
        dedupeKey: `competitor_mentioned:${b.accountId}:${key}`,
        severity: "WARN" as const,
        title: `${name} mentioned${facts.length > 1 ? ` ${facts.length} times` : ""}`,
        explanation: `The customer named ${name}: ${quoted([...facts].sort(newestFirst)[0]!)}.`,
        evidence: evidenceOf(facts),
        values: { mentions: facts.length },
      };
    }),

  budget_concern: (b: SignalBundle, p: ParamsOf<"budget_concern">): SignalCandidate[] => {
    const facts = recent(b, "BUDGET_CONCERN", p.windowDays);
    if (facts.length === 0) return [];
    return [
      {
        dedupeKey: `budget_concern:${b.accountId}`,
        severity: "WARN",
        title: "Budget concern raised",
        explanation: `The customer raised budget: ${quoted([...facts].sort(newestFirst)[0]!)}.`,
        evidence: evidenceOf(facts),
        values: { mentions: facts.length },
      },
    ];
  },

  cancel_language: (b: SignalBundle, p: ParamsOf<"cancel_language">): SignalCandidate[] => {
    const facts = recent(b, "CANCEL_LANGUAGE", p.windowDays);
    if (facts.length === 0) return [];
    return [
      {
        dedupeKey: `cancel_language:${b.accountId}`,
        severity: "CRITICAL",
        title: "Customer talked about cancelling",
        explanation: `${quoted([...facts].sort(newestFirst)[0]!)}. Anything sent in reply goes to a person; it is never sent automatically.`,
        evidence: evidenceOf(facts),
        values: { mentions: facts.length },
      },
    ];
  },

  export_language: (b: SignalBundle, p: ParamsOf<"export_language">): SignalCandidate[] => {
    const facts = recent(b, "EXPORT_LANGUAGE", p.windowDays);
    if (facts.length === 0) return [];
    const cancelling = recent(b, "CANCEL_LANGUAGE", p.windowDays);
    return [
      {
        dedupeKey: `export_language:${b.accountId}`,
        severity: cancelling.length > 0 ? "CRITICAL" : "WARN",
        title: "Customer asked how to take their data out",
        explanation: `${quoted([...facts].sort(newestFirst)[0]!)}.${
          cancelling.length > 0 ? " The same account also talked about cancelling." : ""
        } Anything sent in reply goes to a person.`,
        evidence: evidenceOf([...facts, ...cancelling]),
        values: { mentions: facts.length, alsoCancelling: cancelling.length > 0 ? 1 : 0 },
      },
    ];
  },

  complaint_repeated: (
    b: SignalBundle,
    p: ParamsOf<"complaint_repeated">,
    ctx: EvalContext,
  ): SignalCandidate[] =>
    [...groupBy(recent(b, "COMPLAINT", p.windowDays), (f) => f.theme)].flatMap(([theme, facts]) => {
      const dedupeKey = `complaint_repeated:${b.accountId}:${theme}`;
      const sev = level(ctx.isOpen(dedupeKey), facts.length, {
        fire: p.fireAt,
        clear: p.clearAt,
        critical: p.criticalAt,
      });
      if (!sev) return [];
      return [
        {
          dedupeKey,
          severity: sev,
          title: `${word(facts.length, "complaint")} about ${theme.replaceAll("_", " ")} in ${p.windowDays} days`,
          explanation: `The same theme, ${theme.replaceAll("_", " ")}, in ${word(facts.length, "verified complaint")}: ${quoted([...facts].sort(newestFirst)[0]!)}.`,
          evidence: evidenceOf(facts),
          values: { complaints: facts.length, theme },
        },
      ];
    }),

  repeat_problem: (
    b: SignalBundle,
    p: ParamsOf<"repeat_problem">,
    ctx: EvalContext,
  ): SignalCandidate[] => {
    const support = (b.text ?? []).filter(
      (f) =>
        (f.kind === "COMPLAINT" || f.kind === "THEME") &&
        f.channel === "TICKET" &&
        f.direction === "INBOUND" &&
        f.conversationId !== null &&
        within(f.date, b.asOf, p.windowDays),
    );
    return [...groupBy(support, (f) => f.theme)].flatMap(([theme, facts]) => {
      const tickets = new Set(facts.map((f) => f.conversationId));
      const dedupeKey = `repeat_problem:${b.accountId}:${theme}`;
      const sev = level(ctx.isOpen(dedupeKey), tickets.size, {
        fire: p.fireTickets,
        clear: p.clearTickets,
        critical: p.criticalTickets,
      });
      if (!sev) return [];
      return [
        {
          dedupeKey,
          severity: sev,
          title: `${theme.replaceAll("_", " ")} problem in ${word(tickets.size, "ticket")}`,
          explanation: `The same problem, ${theme.replaceAll("_", " ")}, came back in ${word(tickets.size, "support ticket")} in ${p.windowDays} days: ${quoted([...facts].sort(newestFirst)[0]!)}.`,
          evidence: evidenceOf(facts),
          values: { tickets: tickets.size, theme },
        },
      ];
    });
  },

  angry_sentiment: (
    b: SignalBundle,
    p: ParamsOf<"angry_sentiment">,
    ctx: EvalContext,
  ): SignalCandidate[] => {
    const negative = (b.text ?? []).filter(
      (f) =>
        f.kind === "SENTIMENT" &&
        f.label === "NEGATIVE" &&
        f.sourceType === "MESSAGE" &&
        f.direction === "INBOUND" &&
        within(f.date, b.asOf, p.windowDays),
    );
    const dedupeKey = `angry_sentiment:${b.accountId}`;
    const sev = level(ctx.isOpen(dedupeKey), negative.length, {
      fire: p.fireAt,
      clear: p.clearAt,
      critical: p.criticalAt,
    });
    if (!sev) return [];
    return [
      {
        dedupeKey,
        severity: sev,
        title: `${word(negative.length, "customer message")} read as negative in ${p.windowDays} days`,
        explanation: `${quoted([...negative].sort(newestFirst)[0]!)}. Tone labels are the model's; each is shown only because its quote is in the message.`,
        evidence: evidenceOf(negative),
        values: { negative: negative.length },
      },
    ];
  },

  renewal_concern: (b: SignalBundle, p: ParamsOf<"renewal_concern">): SignalCandidate[] => {
    const facts = recent(b, "RENEWAL_CONCERN", p.windowDays);
    if (facts.length === 0) return [];
    const renewal = b.contract?.renewalDate ?? null;
    const toRenewal = renewal ? daysBetween(b.asOf, renewal) : null;
    const critical =
      toRenewal !== null && toRenewal >= 0 && toRenewal <= p.criticalRenewalWithinDays;
    return [
      {
        dedupeKey: `renewal_concern:${b.accountId}`,
        severity: critical ? "CRITICAL" : "WARN",
        title: "Customer raised a renewal concern",
        explanation: `${quoted([...facts].sort(newestFirst)[0]!)}.${
          critical ? ` The contract renews in ${word(toRenewal!, "day")}.` : ""
        }`,
        evidence: evidenceOf(facts),
        values: { mentions: facts.length, daysToRenewal: toRenewal },
      },
    ];
  },

  no_reply_important_followup: (
    b: SignalBundle,
    p: ParamsOf<"no_reply_important_followup">,
  ): SignalCandidate[] => {
    const messages = b.messages ?? [];
    const IMPORTANT = new Set([
      "question",
      "request",
      "complaint",
      "cancellation",
      "pricing",
      "legal",
      "security",
      "escalation",
    ]);
    return (b.text ?? [])
      .filter(
        (f) =>
          f.kind === "INTENT" &&
          f.sourceType === "MESSAGE" &&
          f.direction === "INBOUND" &&
          f.intent !== null &&
          IMPORTANT.has(f.intent) &&
          f.conversationId !== null &&
          within(f.date, b.asOf, p.lookbackDays) &&
          daysBetween(f.date, b.asOf) >= p.replyWithinDays,
      )
      .filter(
        (f) =>
          !messages.some(
            (m) =>
              m.conversationId === f.conversationId &&
              m.direction === "OUTBOUND" &&
              m.date >= f.date,
          ),
      )
      .map((f) => {
        const waiting = daysBetween(f.date, b.asOf);
        return {
          dedupeKey: `no_reply_important_followup:${b.accountId}:${f.sourceId}`,
          severity: waiting >= p.criticalAfterDays ? ("CRITICAL" as const) : ("WARN" as const),
          title: `No reply to a ${f.intent} for ${word(waiting, "day")}`,
          explanation: `The customer wrote on ${formatDay(f.date)}: “${f.quote}”. Nothing from us in that thread since.`,
          evidence: evidenceOf([f]),
          values: { daysWaiting: waiting, intent: f.intent },
        };
      });
  },

  goal_stated: (b: SignalBundle, p: ParamsOf<"goal_stated">): SignalCandidate[] =>
    recent(b, "GOAL", p.windowDays).map((f) => ({
      dedupeKey: `goal_stated:${b.accountId}:${f.id}`,
      severity: "INFO" as const,
      title: "Customer stated a goal",
      explanation: `${quoted(f)}. It is kept as a goal with this quote.`,
      evidence: evidenceOf([f]),
      values: {},
    })),
};
