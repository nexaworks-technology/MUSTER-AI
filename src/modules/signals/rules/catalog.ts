import { z } from "zod";

/**
 * The M3 signal rules (spec §6D, ARCHITECTURE §5.1–5.2): the four fields every signal must
 * explain, the default thresholds (workspace settings, editable by Admin / CS Leader, audited),
 * and whether a rule is dormant because its data source does not exist yet (D-61).
 * Evaluators live beside this file and are keyed by the same ruleKey.
 */
export type Category =
  "USAGE" | "PEOPLE" | "SUPPORT" | "CALLS_EMAIL" | "MONEY" | "PROMISES" | "OUTSIDE";
export type Polarity = "RISK" | "OPPORTUNITY";

const ratio = z.number().min(0).max(5);
const days = z.number().int().min(1).max(730);

export const PARAMS = {
  usage_drop_vs_normal: z
    .object({
      warnRatio: ratio.default(0.7),
      criticalRatio: ratio.default(0.5),
      clearRatio: ratio.default(0.8),
      minNormalUsers: z.number().min(0).default(3),
      materialDrop: ratio.default(0.15),
    })
    .refine((p) => p.criticalRatio < p.warnRatio && p.warnRatio < p.clearRatio, {
      message: "Critical must be below warn, and warn below the clear level",
    }),
  key_feature_stopped: z
    .object({ activeWeeks: z.number().int().min(1).max(8).default(6), quietDays: days.default(14) })
    .prefault({}),
  power_user_quiet: z
    .object({ quietDays: days.default(14), minActiveWeekShare: ratio.default(0.5) })
    .prefault({}),
  seats_near_limit: z
    .object({
      infoAt: ratio.default(0.9),
      warnAt: ratio.default(1),
      clearBelow: ratio.default(0.85),
      materialPoints: ratio.default(0.1),
    })
    .refine((p) => p.clearBelow < p.infoAt && p.infoAt <= p.warnAt, {
      message: "Clear level < info level ≤ warn level",
    }),
  seats_unused: z
    .object({
      warnAtOrBelow: ratio.default(0.4),
      clearAbove: ratio.default(0.5),
      minContractDays: days.default(60),
      materialPoints: ratio.default(0.1),
    })
    .refine((p) => p.warnAtOrBelow < p.clearAbove, {
      message: "Warn level must be below clear level",
    }),
  ticket_open_too_long: z
    .object({
      targetDays: z
        .object({
          URGENT: days.default(2),
          HIGH: days.default(5),
          NORMAL: days.default(10),
          LOW: days.default(20),
        })
        .prefault({}),
      criticalMultiple: z.number().min(1).max(10).default(2),
    })
    .prefault({}),
  ticket_escalated: z.object({}).prefault({}),
  payment_failed: z
    .object({ criticalFailures: z.number().int().min(1).max(10).default(2) })
    .prefault({}),
  invoice_late: z
    .object({ graceDays: days.default(7), materialDays: days.default(30) })
    .prefault({}),
  renewal_window_90: z
    .object({ fromDays: z.number().int().min(0).default(61), toDays: days.default(90) })
    .prefault({}),
  renewal_window_60: z
    .object({ fromDays: z.number().int().min(0).default(31), toDays: days.default(60) })
    .prefault({}),
  renewal_window_30: z
    .object({ fromDays: z.number().int().min(0).default(0), toDays: days.default(30) })
    .prefault({}),
  no_meeting_in_x_days: z
    .object({ highTouchDays: days.default(45), midTouchDays: days.default(60) })
    .prefault({}),
  contact_bounced_or_left: z
    .object({
      roles: z
        .array(
          z.enum(["CHAMPION", "DECISION_MAKER", "EXEC_SPONSOR", "BILLING", "DAILY_USER", "OTHER"]),
        )
        .min(1)
        .default(["CHAMPION", "DECISION_MAKER", "EXEC_SPONSOR"]),
    })
    .prefault({}),
  outside_event: z.object({ newWithinDays: days.default(30) }).prefault({}),
} as const;

export type RuleKey = keyof typeof PARAMS;
export type ParamsOf<K extends RuleKey> = z.infer<(typeof PARAMS)[K]>;

export interface RuleMeta {
  key: RuleKey;
  label: string;
  category: Category;
  polarity: Polarity;
  meaning: string;
  howDetected: string;
  typicalLeadTime: string;
  falseAlarmCauses: string;
  /** Set when the rule's data source does not exist yet: shown, never run (D-61). */
  dormantReason?: string;
}

export const RULES: readonly RuleMeta[] = [
  {
    key: "usage_drop_vs_normal",
    label: "Usage drop vs normal",
    category: "USAGE",
    polarity: "RISK",
    meaning: "Fewer people are using the product than this account normally has.",
    howDetected:
      "Typical weekday active users in the last 14 days, compared with the account's own normal (13 weeks ending 14 days ago). Warn at 70% of normal or less, critical at 50% or less; clears above 80%.",
    typicalLeadTime: "Often 30–75 days before a churn decision.",
    falseAlarmCauses:
      "Holidays, seasonal businesses, a planned migration, or a data feed that stopped.",
  },
  {
    key: "key_feature_stopped",
    label: "Key feature stopped",
    category: "USAGE",
    polarity: "RISK",
    meaning: "A key feature the account used most weeks has not been used for two weeks.",
    howDetected:
      "Used in at least 6 of the 8 weeks ending 14 days ago, and not at all in the last 14 days.",
    typicalLeadTime: "Weeks before the account notices the gap or starts looking elsewhere.",
    falseAlarmCauses:
      "A workflow was replaced on purpose, or the feature moved to another integration.",
  },
  {
    key: "power_user_quiet",
    label: "Power user gone quiet",
    category: "USAGE",
    polarity: "RISK",
    meaning: "One of the account's most active people has stopped using the product.",
    howDetected:
      "Top 10% of users by activity over the 90 days ending 15 days ago, active in at least half of those weeks, with no activity in the last 14 days. Critical when that person is the champion.",
    typicalLeadTime: "Often the first sign that a champion has left or changed role.",
    falseAlarmCauses: "Leave or holiday, a role change inside the same company, or a new login.",
  },
  {
    key: "seats_near_limit",
    label: "Seats running out",
    category: "USAGE",
    polarity: "OPPORTUNITY",
    meaning: "The account is using almost all the seats it bought, or more.",
    howDetected:
      "Distinct active users in the last 28 days ÷ seats bought. Info at 90%, warn at 100% or more; clears below 85%.",
    typicalLeadTime: "Usually a quarter or more before the renewal conversation.",
    falseAlarmCauses: "Temporary users (contractors, a trial team) or shared logins being split.",
  },
  {
    key: "seats_unused",
    label: "Seats unused",
    category: "USAGE",
    polarity: "RISK",
    meaning: "Most seats the account pays for are not being used.",
    howDetected:
      "Distinct active users in the last 28 days ÷ seats bought is 40% or less, on a contract at least 60 days old; clears above 50%.",
    typicalLeadTime: "Shows up months before a down-sell at renewal.",
    falseAlarmCauses: "A planned roll-out that has not reached every team yet.",
  },
  {
    key: "ticket_open_too_long",
    label: "Ticket open too long",
    category: "SUPPORT",
    polarity: "RISK",
    meaning: "A support ticket has been open longer than its target time.",
    howDetected:
      "Open ticket older than its priority's target (urgent 2, high 5, normal 10, low 20 days): warn; more than twice the target: critical.",
    typicalLeadTime: "Days to weeks before frustration shows in emails or calls.",
    falseAlarmCauses: "Waiting on the customer, or a ticket left open by mistake.",
  },
  {
    key: "ticket_escalated",
    label: "Ticket escalated",
    category: "SUPPORT",
    polarity: "RISK",
    meaning: "A support ticket has been escalated and is still open.",
    howDetected: "An open ticket marked escalated. Critical when it is urgent.",
    typicalLeadTime: "Immediate: an escalation is already a visible problem.",
    falseAlarmCauses: "Escalated for routing only, not because the customer is unhappy.",
  },
  {
    key: "payment_failed",
    label: "Payment failed",
    category: "MONEY",
    polarity: "RISK",
    meaning: "A payment failed and the invoice is still unpaid.",
    howDetected:
      "An invoice with a failed payment that is not paid or voided. Critical after two failures.",
    typicalLeadTime: "Days: an expired card becomes involuntary churn if nobody acts.",
    falseAlarmCauses: "A card being replaced, or a payment made outside the billing system.",
  },
  {
    key: "invoice_late",
    label: "Invoice late",
    category: "MONEY",
    polarity: "RISK",
    meaning: "An invoice is unpaid more than a week after its due date.",
    howDetected:
      "An open invoice more than 7 days past due (failed payments are their own signal).",
    typicalLeadTime: "Weeks before a renewal, late payment often signals budget trouble.",
    falseAlarmCauses: "Slow purchase-order processes, or a payment not yet recorded.",
  },
  {
    key: "renewal_window_90",
    label: "Renewal in 90 days",
    category: "MONEY",
    polarity: "RISK",
    meaning: "The contract renews in 61–90 days.",
    howDetected: "Days from today to the contract's renewal date, in the workspace's time zone.",
    typicalLeadTime: "90 days: time to plan the renewal.",
    falseAlarmCauses: "A renewal date that is wrong in the contract record.",
  },
  {
    key: "renewal_window_60",
    label: "Renewal in 60 days",
    category: "MONEY",
    polarity: "RISK",
    meaning: "The contract renews in 31–60 days.",
    howDetected: "Days from today to the contract's renewal date, in the workspace's time zone.",
    typicalLeadTime: "60 days: most notice periods start soon.",
    falseAlarmCauses: "A renewal date that is wrong in the contract record.",
  },
  {
    key: "renewal_window_30",
    label: "Renewal in 30 days",
    category: "MONEY",
    polarity: "RISK",
    meaning: "The contract renews within 30 days.",
    howDetected: "Days from today to the contract's renewal date, in the workspace's time zone.",
    typicalLeadTime: "30 days: last call for any renewal action.",
    falseAlarmCauses: "A renewal already agreed but not yet recorded.",
  },
  {
    key: "no_meeting_in_x_days",
    label: "No meeting in X days",
    category: "PEOPLE",
    polarity: "RISK",
    meaning: "Nobody has met the account for longer than usual for its tier.",
    howDetected:
      "Days since the last meeting: 45 for high-touch, 60 for mid-touch, none for long-tail.",
    typicalLeadTime: "Weeks to months before the relationship goes cold.",
    falseAlarmCauses: "Meetings held but not logged, or a deliberately low-touch account.",
    dormantReason: "Needs meeting data (arrives in M10).",
  },
  {
    key: "contact_bounced_or_left",
    label: "Key contact bounced or left",
    category: "PEOPLE",
    polarity: "RISK",
    meaning:
      "A champion, decision maker or exec sponsor's email bounced, or they left the company.",
    howDetected:
      "Contact status Bounced or Left on someone who currently holds one of those roles. Critical for the champion.",
    typicalLeadTime: "Often 30–60 days before usage falls.",
    falseAlarmCauses: "A temporary mail problem, or a changed email address.",
  },
  {
    key: "outside_event",
    label: "Outside event",
    category: "OUTSIDE",
    polarity: "RISK",
    meaning:
      "Public news about the customer's company: funding, hiring, leadership change, acquisition.",
    howDetected: "Entered by hand or by CSV, always with a public source link and its date.",
    typicalLeadTime:
      "Varies: an acquisition or a new leader can change a renewal within a quarter.",
    falseAlarmCauses:
      "Old news re-reported, or news about a different company with a similar name.",
  },
];

export const RULE_BY_KEY = new Map(RULES.map((r) => [r.key, r]));

export function parseParams<K extends RuleKey>(key: K, raw: unknown): ParamsOf<K> {
  return PARAMS[key].parse(raw ?? {}) as ParamsOf<K>;
}

export function defaultParams<K extends RuleKey>(key: K): ParamsOf<K> {
  return parseParams(key, {});
}
