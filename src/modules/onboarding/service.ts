/**
 * The onboarding module's public surface (ARCHITECTURE §2): plans, steps, templates, time to value,
 * stall detection and the Sales handoff. Other modules import from here only.
 */
export {
  BLOCKER_ORDER,
  DEFAULT_STALL_PARAMS,
  detectStall,
  factsFromBundle,
  keyFeaturesUnused,
  noActivity,
  overdueSteps,
  ttvLate,
  type Blocker,
  type BlockerKind,
  type OnboardingFacts,
  type OnboardingPlanFacts,
  type StallParams,
  type StallResult,
} from "./stall";
export {
  timeToValue,
  type Source,
  type TtvCohort,
  type TtvInput,
  type TtvPeer,
  type TtvResult,
} from "./ttv";
