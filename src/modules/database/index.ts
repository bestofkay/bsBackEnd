/**
 * Database access layer + Group 6 persistence.
 */

export {
  isDatabaseConfigured,
  getPrisma,
  disconnectDatabase,
  healthCheckDatabase,
} from "./client.js";

export {
  persistExtractionAtomically,
  findByDocumentHash,
  findPersistedByStatementId,
  createQueuedStatement,
  updateStatementStatus,
  resetMemoryPersistence,
  setForceMemoryPersistence,
  EXTRACTION_ENGINE_VERSION,
  PARSER_VERSION,
  type PersistedExtraction,
  type PersistInput,
  type ProcessingStatus,
} from "./persistence.js";

/** @deprecated Use persistExtractionAtomically */
export async function persistExtractionRun(_payload: {
  runId: string;
  success: boolean;
  resultJson?: unknown;
}): Promise<void> {
  // Retained for Group 1–5 callers; Group 6 uses persistExtractionAtomically.
}
