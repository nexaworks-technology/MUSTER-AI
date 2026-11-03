import type { AnyAgentDef } from "../define";
import { healthAnalyst } from "./health-analyst";

/** The agents M4 ships (ARCHITECTURE §6.2; D-30: only the spec's 13 + Ask AI). */
export const M4_AGENTS: AnyAgentDef[] = [healthAnalyst];
