/**
 * The outbound module's public surface (ARCHITECTURE §2, §7.4). Customer email leaves only via
 * dispatch; guards and the sensitive detector are pure and exported for display and for tests.
 */
export { dispatch, DispatchRefusedError, type DispatchResult, type DispatchDeps } from "./dispatch";
export {
  evaluateGuards,
  allPassed,
  GUARDS,
  type GuardResult,
  type GuardName,
  type GuardContext,
} from "./guards";
export {
  detectSensitive,
  SENSITIVE_REASONS,
  type SensitiveReason,
  type SensitiveResult,
} from "./sensitive";
