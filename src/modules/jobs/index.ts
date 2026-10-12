/**
 * Lightweight in-process async extraction job foundation (Group 6+8).
 * Bounded by document semaphore; no external queue required.
 */

import { randomUUID } from "node:crypto";
import type { DocumentInput } from "../../contracts/index.js";
import type { AppConfig } from "../../config/env.js";
import { config as appConfig } from "../../config/env.js";
import { runExtractionPipeline } from "../pipeline/index.js";
import { toPublicExtractionResponse } from "../api/publicResponse.js";
import {
  createQueuedStatement,
  findPersistedByStatementId,
  persistExtractionAtomically,
  updateStatementStatus,
  type ProcessingStatus,
} from "../database/persistence.js";
import { logger } from "../../config/logger.js";
import { createStatementAccess } from "../runtime/accessControl.js";
import { getDocumentSemaphore } from "../api/extractService.js";
import { withTimeout } from "../runtime/limits.js";
import { incMetric } from "../runtime/metrics.js";

export type JobRecord = {
  id: string;
  statementId: string;
  accessToken: string;
  status: ProcessingStatus;
  createdAt: string;
  updatedAt: string;
  error?: { code: string; message: string } | null;
  result?: Record<string, unknown> | null;
};

const jobs = new Map<string, JobRecord>();

export function resetJobs(): void {
  jobs.clear();
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

export function getJobByStatementId(statementId: string): JobRecord | undefined {
  for (const job of jobs.values()) {
    if (job.statementId === statementId) return job;
  }
  return undefined;
}

export async function enqueueExtractionJob(params: {
  document: DocumentInput;
  config: Pick<AppConfig, "maxUploadBytes" | "maxDownloadBytes" | "retainTempFiles">;
  ownerKeyHash?: string | null;
}): Promise<JobRecord> {
  const queued = await createQueuedStatement({
    documentHash: params.document.content_hash ?? null,
    sourceType: params.document.source_type,
    sourceFilename: params.document.original_filename ?? params.document.filename ?? null,
    sourceUrl: params.document.source_url ?? params.document.url ?? null,
    mimeType: params.document.mime_type ?? null,
  });

  const access = createStatementAccess(queued.statementId, params.ownerKeyHash ?? null);
  const now = new Date().toISOString();
  const job: JobRecord = {
    id: randomUUID(),
    statementId: queued.statementId,
    accessToken: access.accessToken,
    status: "QUEUED",
    createdAt: now,
    updatedAt: now,
    error: null,
    result: null,
  };
  jobs.set(job.id, job);
  incMetric("async_jobs_enqueued");

  setImmediate(() => {
    void processJob(job.id, params.document, params.config);
  });

  return job;
}

async function processJob(
  jobId: string,
  document: DocumentInput,
  config: Pick<AppConfig, "maxUploadBytes" | "maxDownloadBytes" | "retainTempFiles">,
): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  const release = await getDocumentSemaphore().acquire();
  job.status = "PROCESSING";
  job.updatedAt = new Date().toISOString();
  await updateStatementStatus(job.statementId, "PROCESSING");

  const started = Date.now();
  try {
    const result = await withTimeout(
      runExtractionPipeline({ document, config }),
      appConfig.maxProcessingTimeMs,
      "PROCESSING_TIMEOUT",
      "Async document processing timed out",
    );
    if (!result.success) {
      job.status = "FAILED";
      job.error = {
        code: result.error.code,
        message: result.error.message,
      };
      job.updatedAt = new Date().toISOString();
      await updateStatementStatus(job.statementId, "FAILED");
      incMetric("documents_failed");
      return;
    }

    const publicResult = toPublicExtractionResponse(result, {
      statementId: job.statementId,
    });
    if (!("success" in publicResult) || publicResult.success !== true) {
      job.status = "FAILED";
      job.error = {
        code: "VALIDATION_FAILED",
        message: "Public response schema validation failed",
      };
      job.updatedAt = new Date().toISOString();
      await updateStatementStatus(job.statementId, "FAILED");
      return;
    }

    const persisted = await persistExtractionAtomically({
      statementId: job.statementId,
      documentHash: document.content_hash ?? null,
      sourceType: document.source_type,
      sourceUrl: document.source_url ?? document.url ?? null,
      sourceFilename: document.original_filename ?? document.filename ?? null,
      mimeType: document.mime_type ?? null,
      runId: result.run_id ?? jobId,
      processingTimeMs: Date.now() - started,
      result,
      publicResult: publicResult as unknown as Record<string, unknown>,
    });

    job.status = persisted.processingStatus;
    job.result = {
      ...publicResult,
      statement_id: persisted.statementId,
      access_token: job.accessToken,
    };
    job.updatedAt = new Date().toISOString();
    await updateStatementStatus(
      job.statementId,
      persisted.processingStatus,
      job.result,
    );
    incMetric("documents_succeeded");
  } catch (err) {
    logger.error({ err, jobId }, "async extraction job failed");
    job.status = "FAILED";
    job.error = {
      code:
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: string }).code)
          : "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : "Job failed",
    };
    job.updatedAt = new Date().toISOString();
    await updateStatementStatus(job.statementId, "FAILED");
    incMetric("documents_failed");
  } finally {
    release();
  }
}

export async function getStatementStatus(statementId: string): Promise<{
  statement_id: string;
  status: ProcessingStatus;
  job_id?: string;
} | null> {
  const job = getJobByStatementId(statementId);
  if (job) {
    return {
      statement_id: statementId,
      status: job.status,
      job_id: job.id,
    };
  }
  const persisted = await findPersistedByStatementId(statementId);
  if (!persisted) return null;
  return {
    statement_id: statementId,
    status: persisted.processingStatus,
  };
}

export async function getStatementResult(statementId: string): Promise<{
  status: ProcessingStatus;
  result: Record<string, unknown> | null;
  error?: { code: string; message: string } | null;
} | null> {
  const job = getJobByStatementId(statementId);
  if (job) {
    return {
      status: job.status,
      result: job.result ?? null,
      error: job.error ?? null,
    };
  }
  const persisted = await findPersistedByStatementId(statementId);
  if (!persisted) return null;
  return {
    status: persisted.processingStatus,
    result: persisted.publicResult,
    error: null,
  };
}
