/**
 * The integrations module's public surface (ARCHITECTURE §2, §8). Other modules and the worker
 * import from here only. Adapters, ingest and credentials stay internal.
 */
export {
  addNightlySyncFlow,
  enqueueSync,
  runSync,
  syncRunPayload,
  type SyncOutcome,
  type SyncRunPayload,
} from "./sync.jobs";
