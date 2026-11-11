/**
 * The ask-ai module's public surface (M11): scoped read tools now; the agent loop, thread
 * persistence, file Q&A and proposals join in later slices.
 */
export {
  ASK_TOOLS,
  runAskTool,
  type AskActor,
  type AskRecord,
  type AskTool,
  type FieldValue,
  type ToolOutput,
} from "./tools";
export { proposeChanges, proposeInput, type ProposalResult, type ProposeInput } from "./proposals";
export {
  askQuestion,
  getThread,
  listThreads,
  AskThreadNotFoundError,
  AskFileNotInThreadError,
  MAX_STEPS,
  ASK_TIMEOUT_MESSAGE,
  ASK_UNAVAILABLE_MESSAGE,
  ASK_DEADLINE_MS,
  type AskDeps,
  type AskResult,
} from "./loop";
export {
  attachFile,
  readAttachmentText,
  selectPassages,
  threadAttachmentIds,
  FILE_NOT_VISIBLE,
  NOT_SCANNED,
} from "./files";
export { loadApprovalCard, decideFromAsk, type AskApprovalCard } from "./cards";
export { loadThreadView, type ThreadMessageView } from "./thread-view";
export { dictationOffered, browserHasSpeechRecognition } from "./schemas";
