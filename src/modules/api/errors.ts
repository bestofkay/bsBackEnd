/**
 * Group 6 API error codes and HTTP status mapping.
 * Internal codes are normalized to the public catalog where possible.
 */

import { createErrorResponse } from "../output/index.js";
import type { ErrorResponse, ExtractionResult } from "../../contracts/index.js";

export const API_ERROR_CODES = [
  "INVALID_INPUT",
  "UNSUPPORTED_FILE_TYPE",
  "FILE_TOO_LARGE",
  "INVALID_DOCUMENT",
  "URL_FETCH_FAILED",
  "URL_BLOCKED",
  "SSRF_BLOCKED",
  "EXTRACTION_FAILED",
  "OCR_FAILED",
  "PARSING_FAILED",
  "VALIDATION_FAILED",
  "RECONCILIATION_FAILED",
  "DATABASE_ERROR",
  "INTERNAL_ERROR",
  "PROCESSING_TIMEOUT",
  "MISSING_FILE",
  "EMPTY_UPLOAD",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "UNSUPPORTED_MEDIA_TYPE",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number] | string;

const CODE_ALIASES: Record<string, string> = {
  URL_HOST_BLOCKED: "SSRF_BLOCKED",
  URL_HOST_NOT_ALLOWED: "URL_BLOCKED",
  BLOCKED_URL_PROTOCOL: "URL_BLOCKED",
  UNSUPPORTED_URL_PROTOCOL: "INVALID_INPUT",
  URL_CREDENTIALS_REJECTED: "INVALID_INPUT",
  INVALID_URL: "INVALID_INPUT",
  EMPTY_REMOTE_FILE: "INVALID_DOCUMENT",
  REMOTE_FILE_NOT_FOUND: "URL_FETCH_FAILED",
  REMOTE_FILE_FORBIDDEN: "URL_FETCH_FAILED",
  REMOTE_FILE_UNAVAILABLE: "URL_FETCH_FAILED",
  REMOTE_FILE_TIMEOUT: "PROCESSING_TIMEOUT",
  TOO_MANY_REDIRECTS: "URL_FETCH_FAILED",
  UNSUPPORTED_CONTENT: "UNSUPPORTED_FILE_TYPE",
  DOCUMENT_NOT_FOUND: "INVALID_DOCUMENT",
  MISSING_LOCAL_DOCUMENT: "INVALID_DOCUMENT",
  INGESTION_FAILED: "INTERNAL_ERROR",
  EXTRACTION_NOT_IMPLEMENTED: "EXTRACTION_FAILED",
};

export function normalizeErrorCode(code: string): string {
  return CODE_ALIASES[code] ?? code;
}

export function publicErrorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ErrorResponse {
  const safeDetails = details
    ? sanitizeErrorDetails(details)
    : undefined;
  return createErrorResponse(normalizeErrorCode(code), message, safeDetails);
}

function sanitizeErrorDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === "path" || key === "local_path" || key === "stack") continue;
    if (typeof value === "string" && /([A-Za-z]:\\|\/tmp\/|\/uploads\/)/.test(value)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function statusForResult(result: ExtractionResult | ErrorResponse): number {
  if (result.success) return 200;
  return statusForErrorCode(result.error.code);
}

export function statusForErrorCode(rawCode: string): number {
  const code = normalizeErrorCode(rawCode);
  switch (code) {
    case "DOCUMENT_LIMIT_EXCEEDED":
      return 413;
    case "RATE_LIMIT_EXCEEDED":
      return 429;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "FILE_TOO_LARGE":
      return 413;
    case "UNSUPPORTED_MEDIA_TYPE":
    case "UNSUPPORTED_FILE_TYPE":
      return 415;
    case "PROCESSING_TIMEOUT":
      return 504;
    case "URL_FETCH_FAILED":
      return 502;
    case "DATABASE_ERROR":
    case "INTERNAL_ERROR":
      return 500;
    case "INVALID_DOCUMENT":
    case "EXTRACTION_FAILED":
    case "OCR_FAILED":
    case "PARSING_FAILED":
    case "VALIDATION_FAILED":
    case "RECONCILIATION_FAILED":
      return 422;
    case "SSRF_BLOCKED":
    case "URL_BLOCKED":
    case "INVALID_INPUT":
    case "MISSING_FILE":
    case "EMPTY_UPLOAD":
    default:
      return 400;
  }
}
