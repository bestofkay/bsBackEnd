/**
 * Output builders for successful and failed API responses.
 */

import {
  ErrorResponseSchema,
  ExtractionResultSchema,
  ExtractionSummarySchema,
  type ErrorResponse,
  type ExtractionResult,
  type ExtractionSummary,
  type QualitySummary,
  type ReconciliationResult,
  type Statement,
  type Transaction,
  type ValidationResult,
  type ExtractionWarning,
} from "../../contracts/index.js";

export function createErrorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ErrorResponse {
  return ErrorResponseSchema.parse({
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  });
}

export function createNotImplementedResult(code: string, message: string): ErrorResponse {
  return createErrorResponse(code, message, { group: 1 });
}

export function buildExtractionSummary(
  statement: Statement,
  transactions: Transaction[],
): ExtractionSummary {
  let debitTotal: number | null = null;
  let creditTotal: number | null = null;

  for (const tx of transactions) {
    if (tx.debit != null) {
      debitTotal = (debitTotal ?? 0) + Math.abs(tx.debit);
    }
    if (tx.credit != null) {
      creditTotal = (creditTotal ?? 0) + Math.abs(tx.credit);
    }
  }

  return ExtractionSummarySchema.parse({
    transaction_count: transactions.length,
    debit_total: debitTotal,
    credit_total: creditTotal,
    currency: statement.currency ?? null,
    period_start: statement.statement_period_start ?? null,
    period_end: statement.statement_period_end ?? null,
  });
}

export function buildSuccessResponse(params: {
  statement: Statement;
  transactions: Transaction[];
  validation: ValidationResult;
  quality: QualitySummary;
  reconciliation?: ReconciliationResult;
  analysis?: Record<string, unknown> | null;
  warnings?: ExtractionWarning[];
  runId?: string | null;
}): ExtractionResult {
  const summary = buildExtractionSummary(params.statement, params.transactions);
  return ExtractionResultSchema.parse({
    success: true,
    statement: params.statement,
    transactions: params.transactions,
    summary,
    validation: params.validation,
    quality: params.quality,
    reconciliation: params.reconciliation,
    analysis: params.analysis ?? null,
    warnings: params.warnings ?? [],
    run_id: params.runId ?? null,
  });
}
