/**
 * End-to-end pipeline.
 * Upload/URL → security → document IR → transactions →
 * duplicates → validation → reconciliation → confidence → canonical JSON.
 */

import { randomUUID } from "node:crypto";
import type { DocumentInput, ErrorResponse, ExtractionResult } from "../../contracts/index.js";
import type { AppConfig } from "../../config/env.js";
import { validateDocumentInput } from "../security/index.js";
import { extractIntermediate } from "../extraction/index.js";
import { logger } from "../../config/logger.js";
import { sanitizeUrlForLogs } from "../security/urlSafety.js";
import { safeUnlink } from "../ingestion/storage.js";
import {
  extractAccountInfo,
  extractStatementMeta,
  reconstructTransactions,
} from "../transactions/index.js";
import { normalizeTransactions } from "../normalization/index.js";
import { validateStatement } from "../validation/index.js";
import {
  applyDuplicateFlags,
  detectDuplicates,
} from "../duplicates/index.js";
import {
  applyConfidenceScores,
  buildQualitySummary,
  scoreAllTransactions,
} from "../confidence/index.js";
import { reconcileBalances } from "../reconciliation/index.js";
import { analyzeStatement } from "../analysis/index.js";
import { buildSuccessResponse, createErrorResponse } from "../output/index.js";
import {
  applyOwnerNameToStatement,
  filterTransactionsByPeriod,
  normalizeAnalysisOptions,
  type AnalysisRequestOptions,
} from "./analysisOptions.js";

export type PipelineResult = ExtractionResult | ErrorResponse;

export type PipelineInput = {
  document: DocumentInput;
  config: Pick<AppConfig, "maxUploadBytes" | "maxDownloadBytes" | "retainTempFiles">;
  analysisOptions?: AnalysisRequestOptions | null;
};

export async function runExtractionPipeline(input: PipelineInput): Promise<PipelineResult> {
  const runId = randomUUID();
  const security = validateDocumentInput(input.document, input.config);
  if (!security.ok) {
    logger.info({ runId, code: security.error.error.code }, "pipeline rejected at security gate");
    return security.error;
  }

  const document: DocumentInput = security.document;
  logger.info(
    {
      runId,
      document_id: document.document_id,
      source_type: document.source_type,
      extension: document.extension,
      mime_type: document.mime_type,
      file_size: document.file_size ?? document.size_bytes,
      source_host: document.source_url
        ? (() => {
            try {
              return new URL(document.source_url).hostname;
            } catch {
              return null;
            }
          })()
        : null,
      source_url: document.source_url ? sanitizeUrlForLogs(document.source_url) : null,
    },
    "pipeline accepted document",
  );

  // Delete source file after success always; on failure respect retainTempFiles.
  let shouldDeleteSource = !input.config.retainTempFiles;
  try {
    const extracted = await extractIntermediate({ runId, document });
    if (!extracted.ok) return extracted.error;

    const intermediate = extracted.intermediate;
    const account = extractAccountInfo(intermediate);
    const statement = extractStatementMeta(intermediate, account);
    statement.source = {
      document_id: document.document_id,
      source_type: document.source_type,
      source_url: document.source_url ?? document.url ?? null,
      original_filename: document.original_filename ?? document.filename ?? null,
      mime_type: document.mime_type ?? null,
      extension: document.extension ?? null,
      file_size: document.file_size ?? document.size_bytes ?? null,
    };

    let transactions = reconstructTransactions(
      intermediate,
      account.currency ?? statement.currency,
    );
    transactions = normalizeTransactions(transactions);

    if (statement.currency) {
      transactions = transactions.map((tx) =>
        tx.currency ? tx : { ...tx, currency: statement.currency },
      );
    }

    // --- Group 5: duplicates (flag only) ---
    const duplicateResult = detectDuplicates(transactions, {
      accountId: account.account_number,
    });
    transactions = applyDuplicateFlags(transactions, duplicateResult);

    // --- Group 5: validation (incl. balance progression) ---
    const validation = validateStatement({
      transactions,
      openingBalance: statement.opening_balance ?? null,
      closingBalance: statement.closing_balance ?? null,
    });

    // --- Group 5: reconciliation ---
    const reconciliation = reconcileBalances({
      openingBalance: statement.opening_balance ?? null,
      closingBalance: statement.closing_balance ?? null,
      transactions,
    });

    // --- Group 5: confidence ---
    const scored = scoreAllTransactions(transactions, validation);
    transactions = applyConfidenceScores(transactions, scored);

    const qualityWarnings = [
      ...duplicateResult.candidates.map((c) => ({
        code: "POSSIBLE_DUPLICATE",
        message: `Possible duplicate between transactions ${c.left_index} and ${c.right_index} (${c.reason})`,
        transaction_index: c.right_index,
        details: {
          group_id: c.group_id,
          level: c.level,
          left_index: c.left_index,
          right_index: c.right_index,
        },
      })),
      ...(reconciliation.reconciliation_status === "MISMATCH"
        ? [
            {
              code: "BALANCE_MISMATCH",
              message: "Statement closing balance does not match calculated closing balance",
              transaction_index: null as number | null,
              details: {
                calculated_closing_balance: reconciliation.calculated_closing_balance,
                statement_closing_balance: reconciliation.statement_closing_balance,
                difference: reconciliation.difference,
              },
            },
          ]
        : []),
      ...(reconciliation.reconciliation_status === "NOT_DETERMINABLE"
        ? [
            {
              code: "RECONCILIATION_NOT_DETERMINABLE",
              message: reconciliation.notes[0] ?? "Reconciliation could not be determined",
              transaction_index: null as number | null,
              details: {},
            },
          ]
        : []),
    ];

    const quality = buildQualitySummary({
      transactions,
      validation,
      duplicateCount: duplicateResult.candidates.length,
      scored,
      extraWarnings: qualityWarnings,
    });

    const warnings = [
      ...extracted.response.warnings,
      ...intermediate.warnings.map((w) => ({
        code: w.code,
        message: w.message,
        path: w.page != null ? `page:${w.page}` : null,
        details: {},
      })),
      ...quality.warnings.map((w) => ({
        code: w.code,
        message: w.message,
        path: w.transaction_index != null ? `transaction:${w.transaction_index}` : null,
        details: w.details ?? {},
      })),
    ];

    const opts = normalizeAnalysisOptions(input.analysisOptions);
    const statementForAnalysis = applyOwnerNameToStatement(statement, opts.ownerName);
    const { scoped, fullCount, scopedCount } = filterTransactionsByPeriod(
      transactions,
      opts.periodStart,
      opts.periodEnd,
    );

    if ((opts.periodStart || opts.periodEnd) && scopedCount === 0) {
      const w = {
        code: "ANALYSIS_WINDOW_EMPTY",
        message:
          "No transactions fall inside the requested analysis date range; analysis used an empty window.",
        path: null as string | null,
        details: {
          period_start: opts.periodStart,
          period_end: opts.periodEnd,
          full_count: fullCount,
        },
      };
      warnings.push(w);
      quality.warnings.push({
        code: w.code,
        message: w.message,
        transaction_index: null,
        details: w.details,
      });
    } else if (opts.periodStart || opts.periodEnd) {
      const w = {
        code: "ANALYSIS_WINDOW_APPLIED",
        message: `Analysis limited to ${opts.periodStart ?? "…"} → ${opts.periodEnd ?? "…"} (${scopedCount} of ${fullCount} transactions).`,
        path: null as string | null,
        details: {
          period_start: opts.periodStart,
          period_end: opts.periodEnd,
          scoped_count: scopedCount,
          full_count: fullCount,
        },
      };
      warnings.push(w);
      quality.warnings.push({
        code: w.code,
        message: w.message,
        transaction_index: null,
        details: w.details,
      });
    }

    const analysisStatement = {
      ...statementForAnalysis,
      statement_period_start:
        opts.periodStart ?? statementForAnalysis.statement_period_start,
      statement_period_end: opts.periodEnd ?? statementForAnalysis.statement_period_end,
    };

    const analysis = analyzeStatement({
      statement: analysisStatement,
      transactions: scoped,
      reconciled: reconciliation.reconciliation_status === "RECONCILED",
    });

    const analysisPayload = {
      ...(analysis as unknown as Record<string, unknown>),
      scoped_transaction_count: scopedCount,
      full_transaction_count: fullCount,
      request: {
        owner_name: opts.ownerName,
        period_start: opts.periodStart,
        period_end: opts.periodEnd,
      },
    };

    const result = buildSuccessResponse({
      statement: statementForAnalysis,
      // Always keep the full ledger for MySQL archival / reconciliation fidelity.
      // Analysis metrics above are computed on the optional date window (scoped).
      transactions,
      validation,
      quality,
      reconciliation,
      analysis: analysisPayload,
      warnings,
      runId,
    });

    logger.info(
      {
        runId,
        document_id: document.document_id,
        method: intermediate.extraction_method,
        transaction_count: transactions.length,
        validation_ok: validation.is_valid,
        duplicates: duplicateResult.candidates.length,
        reconciliation_status: reconciliation.reconciliation_status,
        confidence: quality.confidence,
        analysis_score: analysis.score,
        analysis_band: analysis.score_band,
        analysis_recommendation: analysis.decision_support.recommendation,
      },
      "extraction + analysis complete",
    );

    shouldDeleteSource = true;
    return result;
  } catch (err) {
    logger.error({ err, runId }, "pipeline failed");
    return createErrorResponse(
      "EXTRACTION_FAILED",
      err instanceof Error ? err.message : "Extraction pipeline failed",
      { group: 5 },
    );
  } finally {
    if (shouldDeleteSource) {
      await safeUnlink(document.local_path);
    }
  }
}
