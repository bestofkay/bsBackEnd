/**
 * Transaction module — reconstruction + canonical builders.
 */

export { buildCanonicalTransaction, type RawTransactionDraft } from "./canonical.js";
export {
  reconstructTransactions,
  reconstructFromTable,
  reconstructFromLines,
  dedupeExactLedgerTransactions,
  stitchPagesDroppingOverlap,
} from "./reconstruct.js";
export { extractAccountInfo, extractStatementMeta } from "./account.js";
export {
  isNoiseLine,
  isSummaryLabel,
  isReferenceToken,
  extractReference,
} from "./noise.js";
