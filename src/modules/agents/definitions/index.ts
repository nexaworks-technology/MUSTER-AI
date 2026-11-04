import type { AnyAgentDef } from "../define";
import { adoptionCoach } from "./adoption-coach";
import { healthAnalyst } from "./health-analyst";
import { onboardingManager } from "./onboarding-manager";
import { expansionFinder } from "./expansion-finder";
import { outreach } from "./outreach";
import { renewalManager } from "./renewal-manager";
import { watcher } from "./watcher";

/** The agents M4 ships (ARCHITECTURE §6.2; D-30: only the spec's 13 + Ask AI). */
export const M4_AGENTS: AnyAgentDef[] = [healthAnalyst, watcher, outreach];

/** The agents M6 adds (spec §6E4 Onboarding Manager, §6E5 Adoption Coach). */
export const M6_AGENTS: AnyAgentDef[] = [onboardingManager, adoptionCoach];

/** The agents M7 adds (spec §6E8 Renewal Manager, §6E9 Expansion Finder). */
export const M7_AGENTS: AnyAgentDef[] = [renewalManager, expansionFinder];
