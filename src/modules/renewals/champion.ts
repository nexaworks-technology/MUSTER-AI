/**
 * The champion's state moved to the health module in M9 (D-119): the signal rule `champion_silent`
 * and the renewal confidence read the same function, so the two can never disagree. Re-exported
 * here unchanged for the renewals code and its pinned tests.
 */
export { championState, type ChampionState } from "@/modules/health/service";
