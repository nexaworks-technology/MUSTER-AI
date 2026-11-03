/**
 * The approvals module's public surface (ARCHITECTURE §2, §7.3). The level resolver is pure;
 * the approval lifecycle (approve / edit / reject / bulk) lands with the Approvals screen.
 */
export { resolveLevel, minLevel, LEVELS, DEFAULT_LEVELS, type LevelInput } from "./level-resolver";
