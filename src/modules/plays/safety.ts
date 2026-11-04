import { validateNarrative, type NarrativeBlock } from "@/modules/documents/service";
import { detectSensitive } from "@/modules/outbound/service";
import {
  APPROVAL_LEVELS,
  PLAY_HANDLERS,
  PLAY_TIERS,
  type PlayDefinition,
  type PlayStepDefinition,
} from "./definition";

export interface SafetyCheckResult {
  passed: boolean;
  refusals: string[];
  stepRefusals?: Record<string, string[]>;
}

export interface SafetyContext {
  resolveSegment?: (id: string) => Promise<{ id: string; filter?: unknown } | null>;
  enabledDetectors?: Set<string>;
}

const KNOWN_METRIC_KEYS = [
  "health.score",
  "health.band",
  "health.trend",
  "renewal.date",
  "renewal.daysTo",
  "renewal.confidence",
  "renewal.band",
  "renewal.noticeDeadline",
  "expansion.estimate",
  "expansion.opportunity",
  "expansion.titles",
  "usage.activeUsers",
] as const;

const ALLOWED_MERGE_FIELDS = [
  /\{\{account\.name\}\}/g,
  /\{\{contact\.name\}\}/g,
  /\{\{contact\.first_name\}\}/g,
  /\{\{csm\.name\}\}/g,
  /\{\{csm\.email\}\}/g,
  /\{\{renewal\.date\}\}/g,
];

const DORMANT_TRIGGERS: Record<string, string> = {
  promise_late: "Trigger promise_late has no detector yet (Promise Tracker, M9).",
  engagement_loss: "Trigger engagement_loss has no detector yet (Activity & Engagement, M9/M10).",
  "qbr.due": "Trigger qbr.due has no detector yet (QBR Due, M10).",
  "meeting.qbr_due": "Trigger meeting.qbr_due has no detector yet (QBR Due, M10).",
  "meeting.ended": "Trigger meeting.ended has no detector yet (Business Review Follow-up, M10).",
  "business_review.followup": "Trigger business_review.followup has no detector yet (Business Review Follow-up, M10).",
};

export async function validatePlaySafety(
  play: PlayDefinition,
  ctx: SafetyContext = {},
): Promise<SafetyCheckResult> {
  const refusals: string[] = [];
  const stepRefusals: Record<string, string[]> = {};

  const addStepRefusal = (stepKey: string, reason: string) => {
    refusals.push(reason);
    stepRefusals[stepKey] = stepRefusals[stepKey] ?? [];
    stepRefusals[stepKey]!.push(reason);
  };

  // 1. Dormant triggers check (D9)
  if (play.trigger.type === "signal" && DORMANT_TRIGGERS[play.trigger.ruleKey]) {
    refusals.push(DORMANT_TRIGGERS[play.trigger.ruleKey]!);
  } else if (play.trigger.type === "event" && DORMANT_TRIGGERS[play.trigger.eventType]) {
    refusals.push(DORMANT_TRIGGERS[play.trigger.eventType]!);
  }

  // 2. Segment check (D6)
  if (play.segmentId && ctx.resolveSegment) {
    const seg = await ctx.resolveSegment(play.segmentId);
    if (!seg) {
      refusals.push(`Segment "${play.segmentId}" not found.`);
    } else if (seg.filter) {
      // Check if segment filter explicitly restricts tier to something incompatible with play branches
      const filter = seg.filter as Record<string, { value?: unknown; equals?: unknown } | undefined>;
      const filterTier = filter.tier?.value ?? filter.tier?.equals;
      if (typeof filterTier === "string") {
        for (const b of play.branches ?? []) {
          if (b.tier && b.tier !== filterTier) {
            refusals.push(
              `Segment filter excludes tier "${b.tier}" used in play branch (segment requires "${filterTier}").`,
            );
          }
        }
      }
    }
  }

  // 3. Collect all steps
  const allStepLists: Array<{ name: string; steps: PlayStepDefinition[] }> = [
    { name: "main", steps: play.steps ?? [] },
    ...(play.branches ?? []).map((b, i) => ({ name: `branch-${b.tier ?? i}`, steps: b.steps ?? [] })),
  ];

  const totalSteps = allStepLists.reduce((sum, l) => sum + l.steps.length, 0);
  if (totalSteps === 0) {
    refusals.push("This play does nothing: it has no steps with any effect.");
    return { passed: false, refusals, stepRefusals };
  }

  // Validate each step list
  for (const list of allStepLists) {
    let hasExited = false;
    let lastCustomerSendIndex = -1;
    let waitHoursSinceLastSend = 0;

    for (let i = 0; i < list.steps.length; i++) {
      const step = list.steps[i]!;

      // Reachability
      if (hasExited) {
        addStepRefusal(step.key, `Step "${step.key}" is unreachable: preceded by an exit step.`);
      }
      if (step.handler === "exit") {
        hasExited = true;
      }

      // Handler registration
      if (!PLAY_HANDLERS.includes(step.handler)) {
        addStepRefusal(step.key, `Step "${step.key}" handler "${step.handler}" is not registered.`);
      }

      // Approval levels per tier
      if (!step.approvalLevelByTier) {
        addStepRefusal(step.key, `Step "${step.key}" is missing approval level configuration.`);
      } else {
        for (const t of PLAY_TIERS) {
          const lvl = step.approvalLevelByTier[t];
          if (!lvl || !APPROVAL_LEVELS.includes(lvl)) {
            addStepRefusal(
              step.key,
              `Step "${step.key}" is missing approval level for tier ${t}.`,
            );
          }
        }
      }

      // Handler-specific required settings
      const params = step.params ?? {};
      if (step.handler === "task") {
        if (!params.title || typeof params.title !== "string" || !params.title.trim()) {
          addStepRefusal(
            step.key,
            `Step "${step.key}" is missing required setting: Task title is required.`,
          );
        }
      } else if (step.handler === "notify") {
        if (!params.message || typeof params.message !== "string" || !params.message.trim()) {
          addStepRefusal(
            step.key,
            `Step "${step.key}" is missing required setting: Notification message is required.`,
          );
        }
      } else if (step.handler === "draft" || step.handler === "send") {
        const mode = params.mode ?? (step.handler === "send" ? "template" : "agent");
        if (mode === "template") {
          const body = (params.body ?? params.template) as string | undefined;
          const subject = params.subject as string | undefined;
          if (!body || !subject) {
            addStepRefusal(
              step.key,
              `Step "${step.key}" is missing required setting: Template subject and body are required.`,
            );
          } else {
            // Check template metrics & placeholders (D5)
            let stripped = body;
            let strippedSubj = subject;
            for (const re of ALLOWED_MERGE_FIELDS) {
              stripped = stripped.replace(re, " ");
              strippedSubj = strippedSubj.replace(re, " ");
            }
            const blocks: NarrativeBlock[] = [
              { id: `${step.key}-subject`, type: "paragraph", text: strippedSubj },
              { id: `${step.key}-body`, type: "paragraph", text: stripped },
            ];
            const problems = validateNarrative(blocks, KNOWN_METRIC_KEYS);
            for (const p of problems) {
              addStepRefusal(
                step.key,
                `Step "${step.key}" template placeholder error: ${p.message}`,
              );
            }

            // Sensitive-words check on template content
            const sens = detectSensitive({ texts: [subject, body] });
            if (sens.isSensitive && !step.sensitive) {
              addStepRefusal(
                step.key,
                `Step "${step.key}" contains sensitive language (${sens.reasons.join(", ")}); step must be marked sensitive: true.`,
              );
            }
          }
        } else if (mode === "agent") {
          if (!params.prompt && !params.template) {
            addStepRefusal(
              step.key,
              `Step "${step.key}" is missing required setting: Agent prompt is required.`,
            );
          }
        }
      }

      // Auto-send safety check (Rule 3, §6J.4)
      const hasAutoSend =
        step.approvalLevelByTier &&
        Object.values(step.approvalLevelByTier).some(
          (lvl) => lvl === "SEND_AUTOMATICALLY" || lvl === "DO_AUTOMATICALLY",
        );
      if (hasAutoSend) {
        if (step.sensitive) {
          addStepRefusal(
            step.key,
            `Step "${step.key}" cannot send automatically on a sensitive topic: SEND_AUTOMATICALLY on a sensitive step is forbidden.`,
          );
        } else if (!step.safe) {
          addStepRefusal(
            step.key,
            `Step "${step.key}" has SEND_AUTOMATICALLY on an unsafe step: safe must be true.`,
          );
        } else {
          // Check draft content for sensitive words
          const textToCheck = [params.subject, params.body, params.template, params.message]
            .filter((x): x is string => typeof x === "string");
          if (textToCheck.length > 0) {
            const sens = detectSensitive({ texts: textToCheck });
            if (sens.isSensitive) {
              addStepRefusal(
                step.key,
                `Step "${step.key}" cannot send automatically on a sensitive topic (${sens.reasons.join(", ")}).`,
              );
            }
          }
        }
      }

      // Design-time frequency cap
      const isCustomerSend =
        step.handler === "send" ||
        (step.handler === "draft" && params.mode === "template");
      if (isCustomerSend) {
        if (lastCustomerSendIndex >= 0 && waitHoursSinceLastSend < 48) {
          addStepRefusal(
            step.key,
            `Step "${step.key}" breaches frequency cap: multiple customer messages without at least 48 hours between them.`,
          );
        }
        lastCustomerSendIndex = i;
        waitHoursSinceLastSend = 0;
      } else if (step.handler === "wait") {
        const hours =
          (typeof params.durationHours === "number" ? params.durationHours : 0) +
          (typeof params.durationDays === "number" ? params.durationDays * 24 : 0);
        waitHoursSinceLastSend += hours;
      }
    }
  }

  return {
    passed: refusals.length === 0,
    refusals,
    stepRefusals,
  };
}
