/**
 * The approvals module's public surface (ARCHITECTURE §2, §7.3). requestApproval is the one way
 * any module or agent asks a human; Slack approve (M5) calls the same decide functions with
 * via: "SLACK", which sensitive items refuse.
 */
export { resolveLevel, minLevel, LEVELS, DEFAULT_LEVELS, type LevelInput } from "./level-resolver";
export {
  requestApproval,
  requestApprovalInput,
  listApprovals,
  approvalListQuery,
  getApproval,
  approve,
  canDecideApproval,
  editAndApprove,
  reject,
  bulkDecide,
  bulkInput,
  decisionInput,
  editInput,
  rejectInput,
  ApprovalNotFoundError,
  ApprovalStateError,
  type RequestApprovalInput,
  type DecisionResult,
  type DecideOptions,
  type DecisionChannel,
} from "./lifecycle";
export { resolveProof, parseProof, type ProofLink, type ProofRef } from "./proof";
export {
  changeItem,
  changeList,
  type ChangeItem,
  type ChangeResult,
  type ChangesOutcome,
  type LabelledChange,
} from "./changes";
