export { analyzeStatement, type StatementAnalysis } from "./analyze.js";
export { classifyDescription, classifyNarration, matchLender } from "./classify.js";
export { detectIncomeClusters } from "./income.js";
export {
  ensureFreshAnalysis,
  needsAnalysisRefresh,
  rebuildAnalysisFromPayload,
} from "./refresh.js";
export { buildScorecard } from "./scorecard.js";
export type { AnalysisCategory } from "./patterns.js";
export type {
  AnalysisSignal,
  IncomeCluster,
  LoanEvent,
  ScoreFactor,
} from "./types.js";
