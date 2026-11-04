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
  // M7 B1 (D8): expansion rules. Thresholds are workspace settings, audited like every rule's.
  new_team_using: z
    .object({
      minNewPeople: z.number().int().min(2).max(500).default(8),
      windowDays: days.default(21),
      stableDays: days.default(60),
      stableMaxNew: z.number().int().min(0).max(100).default(2),
      teamShare: ratio.default(0.6),
      teamMinPeople: z.number().int().min(2).max(500).default(3),
    })
    .refine((p) => p.teamShare > 0 && p.teamShare <= 1, {
      message: "Team share must be above 0 and at most 100%",
    }),
  fast_growth: z
    .object({
      growthRatio: ratio.default(1.3),
      strongRatio: ratio.default(1.5),
      clearRatio: ratio.default(1.2),
      minNormalUsers: z.number().min(0).default(3),
      materialPoints: ratio.default(0.15),
    })
    .refine((p) => p.clearRatio < p.growthRatio && p.growthRatio <= p.strongRatio, {
      message: "Clear level < growth level ≤ strong level",
    }),
  goal_stated_expansion: z.object({}).prefault({}),
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
  // M6: onboarding (D4). The thresholds feed the shared stall definition in onboarding/stall.ts.
  onboarding_stall: z
    .object({
      stepOverdueDays: days.default(3),
      noActivityDays: days.default(7),
      keyFeatureByDay: days.default(30),
    })
    .prefault({}),
  onboarding_step_overdue_customer: z
    .object({ stepOverdueDays: days.default(3), criticalDays: days.default(14) })
    .refine((p) => p.criticalDays > p.stepOverdueDays, {
      message: "Critical must be more days overdue than warn",
    })
    .prefault({}),
  onboarding_no_activity: z
    .object({ noActivityDays: days.default(7), criticalDays: days.default(14) })
    .refine((p) => p.criticalDays > p.noActivityDays, {
      message: "Critical must be more quiet days than warn",
    })
    .prefault({}),
  onboarding_key_feature_unused: z.object({ keyFeatureByDay: days.default(30) }).prefault({}),
  onboarding_ttv_late: z.object({}).prefault({}),
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
    meaning: "The account is using almost all the seats (or credits) it bought, or more.",
    howDetected:
      "Distinct active users in the last 28 days ÷ seats bought; and, when the contract has credits and usage reports them, credits used ÷ credits bought. Info at 90%, warn at 100% or more; clears below 85%.",
    typicalLeadTime: "Usually a quarter or more before the renewal conversation.",
    falseAlarmCauses: "Temporary users (contractors, a trial team) or shared logins being split.",
  },
  {
    key: "new_team_using",
    label: "New team using the product",
    category: "USAGE",
    polarity: "OPPORTUNITY",
    meaning: "A burst of people who had never used the product before have started.",
    howDetected:
      "At least 8 people first seen in the last 21 days, after 60 days in which at most 2 people were first seen. Needs per-user usage reaching back far enough to tell who is new. A team is named only when most of the new people share an email subdomain in the data; otherwise it is not named.",
    typicalLeadTime: "A quarter or more before the renewal conversation: new teams buy seats.",
    falseAlarmCauses:
      "A data re-import or a changed login id makes existing people look new; a one-off training day.",
  },
  {
    key: "fast_growth",
    label: "Fast growth",
    category: "USAGE",
    polarity: "OPPORTUNITY",
    meaning: "Far more people are using the product than this account normally has.",
    howDetected:
      "Typical weekday active users in the last 14 days, against this account's own normal over the 8 weeks ending 14 days ago: info at 130% or more, warn at 150% or more; clears below 120%. Not raised during onboarding, where growth is the ramp-up.",
    typicalLeadTime: "Weeks to months before the account hits a paid limit.",
    falseAlarmCauses: "A one-off event, a trial of a new team, or a data feed that doubled.",
  },
  {
    key: "goal_stated_expansion",
    label: "Stated goal needs more seats",
    category: "PEOPLE",
    polarity: "OPPORTUNITY",
    meaning: "A goal the customer stated needs more seats or users than the contract includes.",
    howDetected:
      "Only goals whose measure is explicitly seats or users, with a target number: open goal target above the seats on the contract. Goals with any other measure are ignored until M9.",
    typicalLeadTime: "Months: the customer has said where they are heading.",
    falseAlarmCauses: "A goal quoted from a call that was aspirational, or a target already met.",
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
  // ─── M6: onboarding (spec §6D "adoption stall in onboarding", §6G1) ───
  {
    key: "onboarding_stall",
    label: "Onboarding stalled",
    category: "USAGE",
    polarity: "RISK",
    meaning: "A new customer's onboarding has stopped moving, with the likely blocker named.",
    howDetected:
      "From the onboarding plan: a step past due by 3 days or more (ours first, then the customer's), no one using the product for 7 days, a key feature not used by day 30, or time to value past what 3 in 4 similar accounts take. The first of these is shown as the likely blocker.",
    typicalLeadTime:
      "Weeks before the customer decides the product is not working for them; most onboarding churn starts here.",
    falseAlarmCauses:
      "A plan whose dates were never updated after a deliberate pause, or usage data that stopped arriving.",
  },
  {
    key: "onboarding_step_overdue_customer",
    label: "Customer onboarding step overdue",
    category: "USAGE",
    polarity: "RISK",
    meaning: "A step the customer owns in their onboarding plan is past its due date.",
    howDetected:
      "An open customer-side step 3 days or more past due; critical at 14 days. A blocked step shows its reason.",
    typicalLeadTime: "Days to weeks: an IT task like SSO can hold the whole rollout.",
    falseAlarmCauses:
      "The step was done but nobody marked it, or the plan's dates are out of date.",
  },
  {
    key: "onboarding_no_activity",
    label: "No activity during onboarding",
    category: "USAGE",
    polarity: "RISK",
    meaning: "Nobody at a new customer has used the product recently.",
    howDetected:
      "No active user for 7 days during an open onboarding plan (or since the start); critical at 14 days.",
    typicalLeadTime: "Early: a new customer who stops logging in rarely comes back unprompted.",
    falseAlarmCauses:
      "A planned pause (holiday, data migration), or usage data that stopped arriving.",
  },
  {
    key: "onboarding_key_feature_unused",
    label: "Key feature unused in onboarding",
    category: "USAGE",
    polarity: "RISK",
    meaning: "A key feature of the customer's plan has not been used by the day it usually is.",
    howDetected:
      "No use of a key feature in the account's plan between the plan's start and day 30.",
    typicalLeadTime: "Weeks: value usually depends on the key features being set up.",
    falseAlarmCauses:
      "The feature is not relevant to this customer's use case, or it is used through an API we do not track.",
  },
  {
    key: "onboarding_ttv_late",
    label: "Time to value late",
    category: "USAGE",
    polarity: "RISK",
    meaning: "The customer has not reached first value by the time 3 in 4 similar accounts have.",
    howDetected:
      "Days since the plan started, compared with the time to value of completed plans among similar accounts (same tier, plan and size where there are enough of them), or the plan's own target when there is no history.",
    typicalLeadTime: "Weeks to months before renewal confidence drops.",
    falseAlarmCauses:
      "A larger rollout than usual, or a value definition that does not fit this customer.",
  },
];

export const RULE_BY_KEY = new Map(RULES.map((r) => [r.key, r]));

export function parseParams<K extends RuleKey>(key: K, raw: unknown): ParamsOf<K> {
  return PARAMS[key].parse(raw ?? {}) as ParamsOf<K>;
}

export function defaultParams<K extends RuleKey>(key: K): ParamsOf<K> {
  return parseParams(key, {});
}
