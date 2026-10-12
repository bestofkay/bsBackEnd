/**
 * Shared extract → sanitize → persist → respond orchestration (Group 6+8).
 */

import type { DocumentInput, ErrorResponse } from "../../contracts/index.js";
import type { AppConfig } from "../../config/env.js";
import { config as appConfig } from "../../config/env.js";
import { runExtractionPipeline } from "../pipeline/index.js";
import { toPublicExtractionResponse, type PublicExtractionResponse } from "../api/publicResponse.js";
import { publicErrorResponse } from "../api/errors.js";
import {
  findByDocumentHash,
  persistExtractionAtomically,
} from "../database/persistence.js";
import { logger } from "../../config/logger.js";
import { Semaphore, withTimeout } from "../runtime/limits.js";
import { incMetric } from "../runtime/metrics.js";
import {
  createStatementAccess,
  getStatementAccess,
  registerStatementAccess,
} from "../runtime/accessControl.js";
import type { AnalysisRequestOptions } from "../pipeline/analysisOptions.js";
import { normalizeAnalysisOptions } from "../pipeline/analysisOptions.js";
import {
  allocateReferenceId,
  buildCatalogEntryFromPublic,
  saveCatalogRun,
} from "../catalog/runs.js";
import { safeUnlink } from "../ingestion/storage.js";

export type ExtractServiceResult =
  | { ok: true; status: number; body: PublicExtractionResponse & { access_token?: string } }
  | { ok: false; status: number; body: ErrorResponse };

const documentSemaphore = new Semaphore(appConfig.maxConcurrentDocuments);

export function getDocumentSemaphore(): Semaphore {
  return documentSemaphore;
}

export async function extractAndPersist(params: {
  document: DocumentInput;
  config: Pick<AppConfig, "maxUploadBytes" | "maxDownloadBytes" | "retainTempFiles">;
  force?: boolean;
  ownerKeyHash?: string | null;
  analysisOptions?: AnalysisRequestOptions | null;
}): Promise<ExtractServiceResult> {
  const started = Date.now();
  const hash = params.document.content_hash ?? null;
  incMetric("documents_submitted");
  let release: (() => void) | null = null;

  try {
  if (!params.force && hash) {
    const existing = await findByDocumentHash(hash);
    if (existing?.publicResult && existing.processingStatus !== "FAILED") {
      incMetric("documents_idempotent_replay");
      const access =
        getStatementAccess(existing.statementId) ??
        createStatementAccess(existing.statementId, params.ownerKeyHash ?? null);
      const prior = existing.publicResult;
      const replay = {
        ...prior,
        statement_id: existing.statementId,
        reference_id:
          (typeof prior.reference_id === "string" && prior.reference_id) ||
          null,
        owner_name:
          (typeof prior.owner_name === "string" && prior.owner_name) || null,
        idempotent_replay: true,
        access_token: access.accessToken,
      } as PublicExtractionResponse & { access_token?: string };
      return { ok: true, status: 200, body: replay };
    }
  }

  release = documentSemaphore.tryAcquire();
  if (!release) {
    incMetric("concurrency_rejected");
    return {
      ok: false,
      status: 429,
      body: publicErrorResponse(
        "DOCUMENT_LIMIT_EXCEEDED",
        "Too many documents are being processed concurrently. Retry shortly.",
      ),
    };
  }

  try {
    const analysisOptions = normalizeAnalysisOptions(params.analysisOptions);
    const result = await withTimeout(
      runExtractionPipeline({
        document: params.document,
        config: params.config,
        analysisOptions,
      }),
      appConfig.maxProcessingTimeMs,
      "PROCESSING_TIMEOUT",
      "Document processing exceeded MAX_PROCESSING_TIME_MS",
    );

    if (!result.success) {
      incMetric("documents_failed");
      if (result.error.code === "DOCUMENT_LIMIT_EXCEEDED") {
        return { ok: false, status: 413, body: result };
      }
      return {
        ok: false,
        status: 0,
        body: result,
      };
    }

    const publicResult = toPublicExtractionResponse(result);
    if (!("success" in publicResult) || publicResult.success !== true) {
      incMetric("documents_failed");
      return {
        ok: false,
        status: 422,
        body: publicResult as ErrorResponse,
      };
    }

    try {
      const referenceId = allocateReferenceId();
      const ownerName =
        analysisOptions.ownerName || publicResult.statement.account_name || null;
      const bodyBase: PublicExtractionResponse & {
        reference_id?: string;
        owner_name?: string | null;
        analysis_period?: { from: string | null; to: string | null };
      } = {
        ...publicResult,
        reference_id: referenceId,
        owner_name: ownerName,
        analysis_period: {
          from: analysisOptions.periodStart,
          to: analysisOptions.periodEnd,
        },
      };

      const persisted = await persistExtractionAtomically({
        documentHash: hash,
        sourceType: params.document.source_type,
        sourceUrl: params.document.source_url ?? params.document.url ?? null,
        sourceFilename:
          params.document.original_filename ?? params.document.filename ?? null,
        mimeType: params.document.mime_type ?? null,
        runId: result.run_id ?? `run_${Date.now()}`,
        processingTimeMs: Date.now() - started,
        result,
        publicResult: bodyBase as unknown as Record<string, unknown>,
        referenceId,
        ownerName,
        analysisFrom: analysisOptions.periodStart,
        analysisTo: analysisOptions.periodEnd,
      });

      const access = createStatementAccess(
        persisted.statementId,
        params.ownerKeyHash ?? null,
      );
      registerStatementAccess(access);

      const body = {
        ...bodyBase,
        statement_id: persisted.statementId,
        statement: {
          ...publicResult.statement,
          id: persisted.statementId,
        },
        access_token: access.accessToken,
      };

      // File-catalog mirror when DB unavailable; when MySQL is on, rows already persist above.
      try {
        const entry = buildCatalogEntryFromPublic({
          referenceId,
          publicResult: body as unknown as Record<string, unknown>,
          ownerName: body.owner_name,
          analysisFrom: analysisOptions.periodStart,
          analysisTo: analysisOptions.periodEnd,
          filename:
            params.document.original_filename ?? params.document.filename ?? null,
          source: params.document.source_type === "url" ? "url" : "upload",
        });
        saveCatalogRun({
          entry,
          publicResult: body as unknown as Record<string, unknown>,
        });
      } catch (err) {
        logger.warn({ err, referenceId }, "catalog mirror save failed");
      }

      incMetric("documents_succeeded");
      incMetric("transactions_extracted", result.transactions.length);
      if (result.reconciliation?.reconciliation_status === "RECONCILED") {
        incMetric("reconciliation_success");
      } else if (result.reconciliation?.reconciliation_status === "MISMATCH") {
        incMetric("reconciliation_mismatch");
      }

      return {
        ok: true,
        status: 200,
        body,
      };
    } catch (err) {
      logger.error({ err }, "persistence failed after successful extraction");
      incMetric("database_errors");
      return {
        ok: false,
        status: 500,
        body: publicErrorResponse(
          "DATABASE_ERROR",
          "Extraction succeeded but persistence failed",
        ),
      };
    }
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: string }).code)
        : "INTERNAL_ERROR";
    if (code === "PROCESSING_TIMEOUT") {
      incMetric("timeout_failures");
      return {
        ok: false,
        status: 504,
        body: publicErrorResponse(
          "PROCESSING_TIMEOUT",
          err instanceof Error ? err.message : "Processing timed out",
        ),
      };
    }
    logger.error({ err }, "extractAndPersist failed");
    incMetric("documents_failed");
    return {
      ok: false,
      status: 500,
      body: publicErrorResponse("INTERNAL_ERROR", "Unexpected extraction failure"),
    };
  } finally {
    release?.();
  }
  } finally {
    // Always remove the ingested source after extract/replay unless explicitly retained.
    // Covers idempotent replay and 429 paths that previously left stmt_* orphans.
    if (!params.config.retainTempFiles) {
      await safeUnlink(params.document.local_path);
    }
  }
}
