import type { PlayDefinition } from "../definition";

export interface SeededPlay {
  key: string;
  name: string;
  description: string;
  category: string;
  isDormant?: boolean;
  homeMilestone?: string;
  definition: PlayDefinition;
}

export const SEEDED_PLAYS: SeededPlay[] = [
  // 1. Health Risk (Live)
  {
    key: "health-risk",
    name: "Health Risk",
    description: "Triggers when an account's health score or band drops significantly.",
    category: "risk",
    definition: {
      name: "Health Risk",
      description: "Triggers when an account's health drops into the risk band.",
      category: "risk",
      trigger: { type: "signal", ruleKey: "health_band_drop" },
      steps: [
        {
          key: "notify-csm",
          name: "Notify Account Owner",
          handler: "notify",
          params: { message: "Health score dropped into risk band for {{account.name}}" },
          approvalLevelByTier: {
            HIGH_TOUCH: "NOTIFY_ONLY",
            MID_TOUCH: "NOTIFY_ONLY",
            LONG_TAIL: "NOTIFY_ONLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "review-task",
          name: "Review Health Metrics",
          handler: "task",
          params: {
            title: "Review health metrics and account activity",
            priority: "HIGH",
            dueDays: 2,
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "draft-checkin",
          name: "Draft Check-in Email",
          handler: "draft",
          params: {
            mode: "template",
            subject: "Checking in on {{account.name}}",
            body: "Hi {{contact.first_name}}, I wanted to reach out and check how everything is going with our product.",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
          safe: true,
          sensitive: false,
        },
      ],
    },
  },

  // 2. Renewal Risk (Live)
  {
    key: "renewal-risk",
    name: "Renewal Risk",
    description: "Triggers when a renewal is predicted at risk inside the decision window.",
    category: "renewal",
    definition: {
      name: "Renewal Risk",
      description: "Triggers when renewal risk is detected.",
      category: "renewal",
      trigger: { type: "signal", ruleKey: "renewal_risk" },
      steps: [
        {
          key: "task-prep",
          name: "Prepare Renewal Plan",
          handler: "task",
          params: {
            title: "Review renewal risk factors and talk track",
            priority: "HIGH",
            dueDays: 3,
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "draft-outreach",
          name: "Draft Renewal Outreach",
          handler: "draft",
          params: {
            mode: "template",
            subject: "Upcoming renewal for {{account.name}}",
            body: "Hi {{contact.first_name}}, let's schedule time to discuss your upcoming renewal and roadmap.",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
          safe: true,
          sensitive: false,
        },
      ],
    },
  },

  // 3. Renewal Window (90/60/30) (Live)
  {
    key: "renewal-window",
    name: "Renewal Window",
    description: "Triggers when an account enters the 90-day renewal decision window.",
    category: "renewal",
    definition: {
      name: "Renewal Window",
      description: "Delegates to Renewal Manager when contract enters 90-day window.",
      category: "renewal",
      trigger: { type: "signal", ruleKey: "renewal_window_90" },
      steps: [
        {
          key: "task-window",
          name: "Review Contract Terms",
          handler: "task",
          params: {
            title: "Review contract terms and prepare renewal brief",
            dueDays: 5,
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "draft-renewal",
          name: "Draft Renewal Check-in",
          handler: "draft",
          params: {
            mode: "agent",
            prompt: "Draft renewal check-in for the primary contact",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
          safe: true,
          sensitive: false,
        },
      ],
    },
  },

  // 4. Onboarding Stall (Live)
  {
    key: "onboarding-stall",
    name: "Onboarding Stall",
    description: "Triggers when onboarding progress stalls past agreed milestones.",
    category: "onboarding",
    definition: {
      name: "Onboarding Stall",
      description: "Delegates to Onboarding Manager to unblock stalled customer steps.",
      category: "onboarding",
      trigger: { type: "event", eventType: "onboarding.stalled" },
      steps: [
        {
          key: "task-stall",
          name: "Investigate Stall",
          handler: "task",
          params: {
            title: "Investigate onboarding stall and overdue steps",
            priority: "HIGH",
            dueDays: 1,
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "draft-stall",
          name: "Draft Unblocker Email",
          handler: "draft",
          params: {
            mode: "agent",
            prompt: "Draft onboarding assistance message",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
          safe: true,
          sensitive: false,
        },
      ],
    },
  },

  // 5. New Customer Handoff (Live)
  {
    key: "customer-handoff",
    name: "New Customer Handoff",
    description: "Triggers when a sales deal is closed-won and handoff is initiated.",
    category: "onboarding",
    definition: {
      name: "New Customer Handoff",
      description: "Welcomes new customer and kicks off onboarding plan.",
      category: "onboarding",
      trigger: { type: "event", eventType: "handoff.completed" },
      steps: [
        {
          key: "notify-owner",
          name: "Notify CSM of New Account",
          handler: "notify",
          params: { message: "Sales handoff completed for new customer {{account.name}}" },
          approvalLevelByTier: {
            HIGH_TOUCH: "NOTIFY_ONLY",
            MID_TOUCH: "NOTIFY_ONLY",
            LONG_TAIL: "NOTIFY_ONLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "task-kickoff",
          name: "Schedule Kickoff Call",
          handler: "task",
          params: {
            title: "Schedule onboarding kickoff call with team",
            dueDays: 2,
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "draft-welcome",
          name: "Draft Welcome Email",
          handler: "draft",
          params: {
            mode: "template",
            subject: "Welcome to our platform, {{contact.first_name}}!",
            body: "Hi {{contact.first_name}}, welcome to our platform! I am excited to partner with you.",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
          safe: true,
          sensitive: false,
        },
      ],
    },
  },

  // 6. Champion Loss (Live per D9 on contact_bounced_or_left + power_user_quiet)
  {
    key: "champion-loss",
    name: "Champion Loss",
    description: "Triggers when a key contact or champion leaves or bounces (D9).",
    category: "risk",
    definition: {
      name: "Champion Loss",
      description: "Alerts team to re-establish relationship after champion leaves.",
      category: "risk",
      trigger: { type: "signal", ruleKey: "contact_bounced_or_left" },
      steps: [
        {
          key: "task-champion",
          name: "Map New Stakeholders",
          handler: "task",
          params: {
            title: "Champion left or bounced: map new stakeholders",
            priority: "HIGH",
            dueDays: 2,
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "draft-reconnect",
          name: "Draft Team Reconnect",
          handler: "draft",
          params: {
            mode: "template",
            subject: "Connecting with {{account.name}} team",
            body: "Hello {{contact.first_name}}, following up on our partnership and team updates.",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
          safe: true,
          sensitive: false,
        },
      ],
    },
  },

  // 7. Adoption Drop (Live)
  {
    key: "adoption-drop",
    name: "Adoption Drop",
    description: "Triggers when product usage drops significantly below normal levels.",
    category: "adoption",
    definition: {
      name: "Adoption Drop",
      description: "Coaches account when weekly active usage declines.",
      category: "adoption",
      trigger: { type: "signal", ruleKey: "usage_drop_vs_normal" },
      steps: [
        {
          key: "task-adoption",
          name: "Analyze Usage Decline",
          handler: "task",
          params: {
            title: "Analyze feature usage drop and inactive users",
            dueDays: 3,
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "draft-adoption",
          name: "Draft Adoption Guidance",
          handler: "draft",
          params: {
            mode: "agent",
            prompt: "Draft coaching outreach regarding feature adoption",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
          safe: true,
          sensitive: false,
        },
      ],
    },
  },

  // 8. Expansion Opportunity (Live)
  {
    key: "expansion-opportunity",
    name: "Expansion Opportunity",
    description: "Triggers when seat limit is approached or expansion signal fires.",
    category: "expansion",
    definition: {
      name: "Expansion Opportunity",
      description: "Identifies and qualifies expansion opportunities.",
      category: "expansion",
      trigger: { type: "signal", ruleKey: "seats_nearing_limit" },
      steps: [
        {
          key: "task-opp",
          name: "Evaluate Expansion Scope",
          handler: "task",
          params: {
            title: "Evaluate seat expansion opportunity",
            dueDays: 4,
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "draft-opp",
          name: "Draft Expansion Proposal",
          handler: "draft",
          params: {
            mode: "agent",
            prompt: "Draft expansion proposal for seat tier upgrade",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
          safe: true,
          sensitive: false,
        },
      ],
    },
  },

  // 9. Payment Failed (Live)
  {
    key: "payment-failed",
    name: "Payment Failed",
    description: "Triggers when a subscription payment fails in billing provider.",
    category: "billing",
    definition: {
      name: "Payment Failed",
      description: "Sends safe reminder to update payment details with auto-send on long-tail.",
      category: "billing",
      trigger: { type: "event", eventType: "invoice.payment_failed" },
      steps: [
        {
          key: "remind-billing",
          name: "Payment Update Reminder",
          handler: "send",
          safe: true,
          sensitive: false,
          params: {
            mode: "template",
            subject: "Action required: update payment method for {{account.name}}",
            body: "Hi {{contact.first_name}}, we were unable to process your latest payment. Please update your billing details.",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "SEND_AUTOMATICALLY",
          },
        },
      ],
    },
  },

  // 10. Support Escalation / SLA Breach (Live)
  {
    key: "support-escalation",
    name: "Support Escalation",
    description: "Triggers when a high-priority support ticket breaches SLA.",
    category: "support",
    definition: {
      name: "Support Escalation",
      description: "Escalates support ticket SLA breaches to CS leadership.",
      category: "support",
      trigger: { type: "signal", ruleKey: "support_escalation" },
      steps: [
        {
          key: "escalate-task",
          name: "Escalate to Leader",
          handler: "escalate",
          params: {
            title: "Support ticket SLA breached or escalated",
            priority: "HIGH",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "notify-csm",
          name: "Notify Account Owner",
          handler: "notify",
          params: { message: "Support ticket escalated on {{account.name}}" },
          approvalLevelByTier: {
            HIGH_TOUCH: "NOTIFY_ONLY",
            MID_TOUCH: "NOTIFY_ONLY",
            LONG_TAIL: "NOTIFY_ONLY",
          },
          safe: true,
          sensitive: false,
        },
      ],
    },
  },

  // 11. Promise Late (Dormant - M9)
  {
    key: "promise-late",
    name: "Promise Late",
    description: "[Dormant - M9] Trigger promise_late has no detector yet (Promise Tracker, M9).",
    category: "promises",
    isDormant: true,
    homeMilestone: "M9",
    definition: {
      name: "Promise Late",
      description: "[Dormant - M9] Trigger promise_late has no detector yet (Promise Tracker, M9).",
      category: "promises",
      trigger: { type: "signal", ruleKey: "promise_late" },
      steps: [
        {
          key: "task-promise",
          name: "Review Overdue Promise",
          handler: "task",
          params: {
            title: "Follow up on overdue customer promise",
            priority: "HIGH",
            dueDays: 1,
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
      ],
    },
  },

  // 12. QBR Due (Dormant - M10)
  {
    key: "qbr-due",
    name: "QBR Due",
    description: "[Dormant - M10] Trigger qbr.due has no detector yet (QBR Due, M10).",
    category: "general",
    isDormant: true,
    homeMilestone: "M10",
    definition: {
      name: "QBR Due",
      description: "[Dormant - M10] Trigger qbr.due has no detector yet (QBR Due, M10).",
      category: "general",
      trigger: { type: "event", eventType: "qbr.due" },
      steps: [
        {
          key: "task-qbr",
          name: "Schedule Business Review",
          handler: "task",
          params: {
            title: "Schedule quarterly business review",
            dueDays: 7,
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
      ],
    },
  },

  // 13. Engagement Loss / Re-engagement (Dormant - M9/M10)
  {
    key: "engagement-loss",
    name: "Engagement Loss",
    description: "[Dormant - M9/M10] Trigger engagement_loss has no detector yet (Activity & Engagement, M9/M10).",
    category: "risk",
    isDormant: true,
    homeMilestone: "M9/M10",
    definition: {
      name: "Engagement Loss",
      description: "[Dormant - M9/M10] Trigger engagement_loss has no detector yet (Activity & Engagement, M9/M10).",
      category: "risk",
      trigger: { type: "signal", ruleKey: "engagement_loss" },
      steps: [
        {
          key: "task-engagement",
          name: "Executive Re-engagement",
          handler: "task",
          params: {
            title: "Executive outreach for disengaged account",
            dueDays: 3,
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
      ],
    },
  },

  // 14. Cancellation Save (Live per D9 on noteTag: cancellation-risk, sensitive: true)
  {
    key: "cancellation-save",
    name: "Cancellation Save",
    description: "Triggers on noteTag cancellation-risk; all customer steps sensitive (D9).",
    category: "risk",
    definition: {
      name: "Cancellation Save",
      description: "Rapid response to cancellation risk notes. Customer steps always sensitive.",
      category: "risk",
      trigger: { type: "noteTag", tag: "cancellation-risk" },
      steps: [
        {
          key: "task-save",
          name: "Executive Save Review",
          handler: "task",
          params: {
            title: "URGENT: Executive review for cancellation risk",
            priority: "HIGH",
            dueDays: 1,
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
        {
          key: "draft-offer",
          name: "Draft Save Offer",
          handler: "draft",
          safe: true,
          sensitive: true, // Sensitive topic: Rule 3
          params: {
            mode: "template",
            subject: "Regarding your subscription with {{account.name}}",
            body: "Hi {{contact.first_name}}, we received word that you may be looking at alternatives. I would love to connect.",
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DRAFT_FOR_APPROVAL",
            MID_TOUCH: "DRAFT_FOR_APPROVAL",
            LONG_TAIL: "DRAFT_FOR_APPROVAL",
          },
        },
      ],
    },
  },

  // 15. Business Review Follow-up (Dormant - M10)
  {
    key: "business-review-followup",
    name: "Business Review Follow-up",
    description: "[Dormant - M10] Trigger business_review.followup has no detector yet (Business Review Follow-up, M10).",
    category: "general",
    isDormant: true,
    homeMilestone: "M10",
    definition: {
      name: "Business Review Follow-up",
      description: "[Dormant - M10] Trigger business_review.followup has no detector yet (Business Review Follow-up, M10).",
      category: "general",
      trigger: { type: "event", eventType: "business_review.followup" },
      steps: [
        {
          key: "task-followup",
          name: "Send Meeting Notes",
          handler: "task",
          params: {
            title: "Send business review executive summary and agreed milestones",
            dueDays: 2,
          },
          approvalLevelByTier: {
            HIGH_TOUCH: "DO_AUTOMATICALLY",
            MID_TOUCH: "DO_AUTOMATICALLY",
            LONG_TAIL: "DO_AUTOMATICALLY",
          },
          safe: true,
          sensitive: false,
        },
      ],
    },
  },
];
