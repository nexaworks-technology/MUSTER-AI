import type { AnyAgentDef } from "../define";
import { adoptionCoach } from "./adoption-coach";
import { healthAnalyst } from "./health-analyst";
import { onboardingManager } from "./onboarding-manager";
import { outreach } from "./outreach";
import { watcher } from "./watcher";

/** The agents M4 ships (ARCHITECTURE §6.2; D-30: only the spec's 13 + Ask AI). */
export const M4_AGENTS: AnyAgentDef[] = [healthAnalyst, watcher, outreach];

/** The agents M6 adds (spec §6E4 Onboarding Manager, §6E5 Adoption Coach). */
export const M6_AGENTS: AnyAgentDef[] = [onboardingManager, adoptionCoach];
