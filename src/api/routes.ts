import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "../config/env.js";
import {
  ingestRemoteUrl,
  ingestUploadedFile,
  safeUnlink,
} from "../modules/ingestion/index.js";
import { healthCheckDatabase, isDatabaseConfigured } from "../modules/database/index.js";
import { extractAndPersist } from "../modules/api/extractService.js";
import {
  publicErrorResponse,
  statusForErrorCode,
  statusForResult,
} from "../modules/api/errors.js";
import {
  enqueueExtractionJob,
  getStatementResult,
  getStatementStatus,
} from "../modules/jobs/index.js";
import { openApiDocument } from "./openapi.js";
import type { DocumentInput, ErrorResponse } from "../contracts/index.js";
import { rateLimitMiddleware } from "../modules/runtime/rateLimit.js";
import { requireWebSession } from "../modules/runtime/auth.js";
import { verifyStatementAccess } from "../modules/runtime/accessControl.js";
import { incMetric } from "../modules/runtime/metrics.js";
import {
  buildCatalogEntryFromPublic,
  getCatalogEntryAsync,
  getCatalogPayloadAsync,
  searchCatalog,
  upsertAnalysisInDb,
} from "../modules/catalog/runs.js";
import { ensureFreshAnalysis } from "../modules/analysis/refresh.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
});

const dateOnly = z
  .union([
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
    z.literal(""),
    z.null(),
  ])
  .optional()
  .transform((v) => (v ? v : null));

const analysisFieldsSchema = z.object({
  owner_name: z.string().trim().max(200).optional().nullable(),
  period_start: dateOnly,
  period_end: dateOnly,
  /** Aliases accepted from multipart / JSON */
  analysis_start: dateOnly,
  analysis_end: dateOnly,
});

const urlBodySchema = z
  .object({
    source_type: z.literal("url").optional(),
    url: z.string().url(),
    password: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
    force: z.boolean().optional(),
  })
  .merge(analysisFieldsSchema);

function analysisOptionsFromBody(body: {
  owner_name?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  analysis_start?: string | null;
  analysis_end?: string | null;
}) {
  const owner = typeof body.owner_name === "string" ? body.owner_name.trim() : "";
  return {
    ownerName: owner || null,
    periodStart: body.period_start || body.analysis_start || null,
    periodEnd: body.period_end || body.analysis_end || null,
  };
}

function ingestConfig() {
  return {
    maxUploadBytes: config.maxUploadBytes,
    maxDownloadBytes: config.maxDownloadBytes,
    uploadDir: config.uploadDir,
    allowedUrlHosts: config.allowedUrlHosts,
    urlConnectTimeoutMs: config.urlConnectTimeoutMs,
    urlDownloadTimeoutMs: config.urlDownloadTimeoutMs,
    urlMaxRedirects: config.urlMaxRedirects,
  };
}

function pipelineConfig() {
  return {
    maxUploadBytes: config.maxUploadBytes,
    maxDownloadBytes: config.maxDownloadBytes,
    retainTempFiles: config.retainTempFiles,
  };
}

function sendError(res: Response, body: ErrorResponse, statusOverride?: number): void {
  const normalized = publicErrorResponse(body.error.code, body.error.message, body.error.details);
  if (normalized.error.code === "SSRF_BLOCKED" || normalized.error.code === "URL_BLOCKED") {
    incMetric("ssrf_blocks");
  }
  if (normalized.error.code === "FILE_TOO_LARGE") {
    incMetric("oversized_uploads");
  }
  if (normalized.error.code === "URL_FETCH_FAILED") {
    incMetric("url_fetch_failures");
  }
  res
    .status(statusOverride ?? statusForErrorCode(normalized.error.code))
    .json(normalized);
}

function extractAccessToken(req: Request): string | null {
  const header = req.headers["x-access-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const q = req.query.access_token;
  if (typeof q === "string" && q.trim()) return q.trim();
  return null;
}

function assertStatementAccess(req: Request, res: Response, statementId: string): boolean {
  const check = verifyStatementAccess({
    statementId,
    accessToken: extractAccessToken(req),
    callerKeyHash: req.auth?.apiKeyHash ?? null,
  });
  if (check.ok) return true;
  if (check.code === "NOT_FOUND") {
    sendError(res, publicErrorResponse("NOT_FOUND", "Statement not found"));
    return false;
  }
  sendError(res, publicErrorResponse("FORBIDDEN", "Statement access denied"));
  return false;
}

async function respondWithDocument(
  document: DocumentInput,
  res: Response,
  req: Request,
  options: {
    force?: boolean;
    async?: boolean;
    analysisOptions?: ReturnType<typeof analysisOptionsFromBody>;
  } = {},
): Promise<void> {
  const ownerKeyHash = req.auth?.apiKeyHash ?? null;

  if (options.async) {
    const job = await enqueueExtractionJob({
      document,
      config: pipelineConfig(),
      ownerKeyHash,
    });
    res.status(202).json({
      success: true,
      statement_id: job.statementId,
      job_id: job.id,
      status: job.status,
      access_token: job.accessToken,
    });
    return;
  }

  const outcome = await extractAndPersist({
    document,
    config: pipelineConfig(),
    force: options.force,
    ownerKeyHash,
    analysisOptions: options.analysisOptions,
  });

  if (!outcome.ok) {
    if (outcome.status > 0) {
      sendError(res, outcome.body, outcome.status);
      return;
    }
    sendError(res, outcome.body, statusForResult(outcome.body));
    return;
  }

  res.status(outcome.status).json(outcome.body);
}

async function handleUrlExtraction(
  body: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
  options: { async?: boolean } = {},
): Promise<void> {
  try {
    const parsed = urlBodySchema.safeParse(body);
    if (!parsed.success) {
      sendError(
        res,
        publicErrorResponse(
          "INVALID_INPUT",
          "A supported statement file or HTTP(S) URL is required.",
          { issues: parsed.error.issues },
        ),
      );
      return;
    }

    const ingested = await ingestRemoteUrl(
      {
        url: parsed.data.url,
        password: parsed.data.password ?? null,
        metadata: parsed.data.metadata,
      },
      ingestConfig(),
    );

    if (!ingested.ok) {
      sendError(res, ingested.error);
      return;
    }

    try {
      await respondWithDocument(ingested.document, res, req, {
        force: parsed.data.force,
        async: options.async,
        analysisOptions: analysisOptionsFromBody(parsed.data),
      });
    } catch (err) {
      await safeUnlink(ingested.document.local_path);
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

export const apiRouter = Router();

apiRouter.get("/health", async (_req, res) => {
  const db = await healthCheckDatabase({ failIfUnreachable: false });
  res.status(200).json({
    success: true,
    service: "bs-app",
    group: 8,
    database: db,
  });
});

apiRouter.get("/ready", async (_req, res) => {
  if (!isDatabaseConfigured()) {
    res.status(200).json({ success: true, status: "ready", database: { configured: false } });
    return;
  }
  const db = await healthCheckDatabase({ failIfUnreachable: true });
  res.status(db.ok ? 200 : 503).json({
    success: db.ok,
    status: db.ok ? "ready" : "not_ready",
    database: db,
  });
});

apiRouter.get("/docs/openapi.json", (_req, res) => {
  res.status(200).json(openApiDocument);
});

/** Search completed analyses by owner name, reference ID, or free text (MySQL). */
apiRouter.get("/v1/analyses/search", requireWebSession, async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() || null : null;
    const owner = typeof req.query.owner === "string" ? req.query.owner.trim() || null : null;
    const referenceIdRaw =
      typeof req.query.reference_id === "string"
        ? req.query.reference_id
        : typeof req.query.ref === "string"
          ? req.query.ref
          : null;
    const referenceId = referenceIdRaw?.trim() || null;
    if (!q && !owner && !referenceId) {
      sendError(
        res,
        publicErrorResponse(
          "INVALID_INPUT",
          "Provide at least one of q, owner, or reference_id",
        ),
      );
      return;
    }
    const limit = Number(req.query.limit ?? 50);
    const { total, results } = await searchCatalog({ q, owner, referenceId, limit });
    res.status(200).json({
      success: true,
      storage: isDatabaseConfigured() ? "mysql" : "file",
      total,
      results,
    });
  } catch (err) {
    next(err);
  }
});

/** Fetch a full analysis payload by allocated reference ID (e.g. APT-A1B2C3D4). */
apiRouter.get("/v1/analyses/:referenceId", requireWebSession, async (req, res, next) => {
  try {
    const referenceId = req.params.referenceId;
    const [entry, payload] = await Promise.all([
      getCatalogEntryAsync(referenceId),
      getCatalogPayloadAsync(referenceId),
    ]);
    if (!payload) {
      sendError(res, publicErrorResponse("NOT_FOUND", "Analysis reference not found"));
      return;
    }
    // Backfill day/week + loan timing when older stored analyses lack them.
    const fresh = ensureFreshAnalysis(payload);
    let result = fresh.payload;
    let nextEntry = entry;
    if (fresh.refreshed && fresh.analysis) {
      const ref =
        (typeof result.reference_id === "string" && result.reference_id) ||
        referenceId;
      nextEntry =
        entry ??
        buildCatalogEntryFromPublic({
          referenceId: ref,
          publicResult: result,
          ownerName: (result.owner_name as string) ?? null,
          filename: null,
          source: "other",
        });
      const enriched = { ...result, reference_id: ref };
      try {
        await upsertAnalysisInDb({
          entry: { ...nextEntry, reference_id: ref },
          publicResult: enriched,
          analysisJson: fresh.analysis as unknown as Record<string, unknown>,
        });
      } catch (persistErr) {
        // Still return the refreshed analysis even if persistence fails.
        console.error("analysis refresh persist failed", persistErr);
      }
      result = enriched;
    }
    res.status(200).json({
      success: true,
      storage: isDatabaseConfigured() ? "mysql" : "file",
      entry: nextEntry ?? null,
      result,
      analysis_refreshed: fresh.refreshed,
    });
  } catch (err) {
    next(err);
  }
});

apiRouter.get("/v1/docs/openapi.json", (_req, res) => {
  res.status(200).json(openApiDocument);
});

const extractRateLimit = rateLimitMiddleware({
  name: "extract",
  max: config.rateLimitExtractMax,
  windowMs: config.rateLimitWindowMs,
});

/**
 * Unified extract endpoint.
 * - multipart/form-data with `file` → upload ingestion
 * - application/json with `{ source_type: "url", url }` → remote ingestion
 */
apiRouter.post(
  "/v1/statements/extract",
  extractRateLimit,
  (req, res, next) => {
    const contentType = req.headers["content-type"] ?? "";
    if (contentType.includes("multipart/form-data")) {
      upload.single("file")(req, res, next);
      return;
    }
    next();
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.file) {
        if (!req.file.buffer || req.file.buffer.length === 0) {
          sendError(
            res,
            publicErrorResponse("INVALID_INPUT", "Uploaded file is empty."),
          );
          return;
        }
        const password =
          typeof req.body?.password === "string" ? req.body.password : null;
        const force = req.body?.force === "true" || req.body?.force === true;
        const analysisOptions = analysisOptionsFromBody({
          owner_name:
            typeof req.body?.owner_name === "string" ? req.body.owner_name : null,
          period_start:
            typeof req.body?.period_start === "string" ? req.body.period_start : null,
          period_end:
            typeof req.body?.period_end === "string" ? req.body.period_end : null,
          analysis_start:
            typeof req.body?.analysis_start === "string"
              ? req.body.analysis_start
              : null,
          analysis_end:
            typeof req.body?.analysis_end === "string" ? req.body.analysis_end : null,
        });

        const ingested = await ingestUploadedFile(
          {
            filename: req.file.originalname,
            declaredMimeType: req.file.mimetype,
            buffer: req.file.buffer,
            password,
          },
          ingestConfig(),
        );

        if (!ingested.ok) {
          sendError(res, ingested.error);
          return;
        }

        try {
          await respondWithDocument(ingested.document, res, req, {
            force,
            analysisOptions,
          });
        } catch (err) {
          await safeUnlink(ingested.document.local_path);
          throw err;
        }
        return;
      }

      if (req.body && typeof req.body === "object" && "url" in req.body) {
        await handleUrlExtraction(req.body, req, res, next);
        return;
      }

      sendError(
        res,
        publicErrorResponse(
          "INVALID_INPUT",
          "A supported statement file or HTTP(S) URL is required.",
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

/** Async enqueue — same ingestion paths, returns 202. */
apiRouter.post(
  "/v1/statements",
  extractRateLimit,
  (req, res, next) => {
    const contentType = req.headers["content-type"] ?? "";
    if (contentType.includes("multipart/form-data")) {
      upload.single("file")(req, res, next);
      return;
    }
    next();
  },
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.file) {
        const password =
          typeof req.body?.password === "string" ? req.body.password : null;
        const ingested = await ingestUploadedFile(
          {
            filename: req.file.originalname,
            declaredMimeType: req.file.mimetype,
            buffer: req.file.buffer,
            password,
          },
          ingestConfig(),
        );
        if (!ingested.ok) {
          sendError(res, ingested.error);
          return;
        }
        await respondWithDocument(ingested.document, res, req, { async: true });
        return;
      }
      if (req.body && typeof req.body === "object" && "url" in req.body) {
        await handleUrlExtraction(req.body, req, res, next, { async: true });
        return;
      }
      sendError(
        res,
        publicErrorResponse(
          "INVALID_INPUT",
          "A supported statement file or HTTP(S) URL is required.",
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

apiRouter.get("/v1/statements/:id/status", async (req, res) => {
  if (!assertStatementAccess(req, res, req.params.id)) return;
  const status = await getStatementStatus(req.params.id);
  if (!status) {
    sendError(res, publicErrorResponse("NOT_FOUND", "Statement not found"));
    return;
  }
  res.status(200).json({ success: true, ...status });
});

apiRouter.get("/v1/statements/:id/result", async (req, res) => {
  if (!assertStatementAccess(req, res, req.params.id)) return;
  const payload = await getStatementResult(req.params.id);
  if (!payload) {
    sendError(res, publicErrorResponse("NOT_FOUND", "Statement not found"));
    return;
  }
  if (payload.status === "QUEUED" || payload.status === "PROCESSING") {
    res.status(202).json({
      success: true,
      statement_id: req.params.id,
      status: payload.status,
    });
    return;
  }
  if (payload.status === "FAILED") {
    sendError(
      res,
      publicErrorResponse(
        payload.error?.code ?? "EXTRACTION_FAILED",
        payload.error?.message ?? "Extraction failed",
      ),
      422,
    );
    return;
  }
  res.status(200).json(payload.result);
});

apiRouter.post("/v1/statements/extract-url", extractRateLimit, async (req, res, next) => {
  await handleUrlExtraction({ source_type: "url", ...req.body }, req, res, next);
});

// ---- Group 1 compatibility aliases (deprecated) ----
apiRouter.post("/extract/url", extractRateLimit, async (req, res, next) => {
  await handleUrlExtraction({ source_type: "url", ...req.body }, req, res, next);
});

apiRouter.post(
  "/extract/upload",
  extractRateLimit,
  upload.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        sendError(
          res,
          publicErrorResponse("MISSING_FILE", "multipart field 'file' is required"),
        );
        return;
      }
      const password =
        typeof req.body?.password === "string" ? req.body.password : null;
      const ingested = await ingestUploadedFile(
        {
          filename: req.file.originalname,
          declaredMimeType: req.file.mimetype,
          buffer: req.file.buffer,
          password,
        },
        ingestConfig(),
      );
      if (!ingested.ok) {
        sendError(res, ingested.error);
        return;
      }
      await respondWithDocument(ingested.document, res, req);
    } catch (err) {
      next(err);
    }
  },
);
