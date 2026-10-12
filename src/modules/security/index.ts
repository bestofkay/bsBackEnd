/**
 * Security module — document-level validation after ingestion.
 * URL SSRF checks live in urlSafety.ts; magic-byte sniffing in fileType.ts.
 */

import { DocumentInputSchema, type DocumentInput, type ErrorResponse } from "../../contracts/index.js";
import type { AppConfig } from "../../config/env.js";
import { createErrorResponse } from "../output/index.js";
import { validateUrlForFetch } from "./urlSafety.js";

export type SecurityCheckResult =
  | { ok: true; document: DocumentInput }
  | { ok: false; error: ErrorResponse };

export function validateDocumentInput(
  raw: unknown,
  config: Pick<AppConfig, "maxUploadBytes" | "maxDownloadBytes">,
): SecurityCheckResult {
  const parsed = DocumentInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: createErrorResponse(
        "INVALID_INPUT",
        parsed.error.issues.map((i) => i.message).join("; ") || "Invalid document input",
        { issues: parsed.error.issues },
      ),
    };
  }

  const document = parsed.data;
  const size = document.file_size ?? document.size_bytes;
  const maxBytes =
    document.source_type === "url" ? config.maxDownloadBytes : config.maxUploadBytes;

  if (size != null && size > maxBytes) {
    return {
      ok: false,
      error: createErrorResponse(
        "FILE_TOO_LARGE",
        `File exceeds maximum allowed size of ${maxBytes} bytes`,
      ),
    };
  }

  if (!document.local_path) {
    return {
      ok: false,
      error: createErrorResponse(
        "MISSING_LOCAL_DOCUMENT",
        "Document must be materialized to a local path before extraction",
      ),
    };
  }

  if (!document.mime_type || !document.extension) {
    return {
      ok: false,
      error: createErrorResponse(
        "UNSUPPORTED_FILE_TYPE",
        "Supported types: PDF, CSV, XLS, XLSX, JPG, JPEG, PNG",
      ),
    };
  }

  return { ok: true, document };
}

/**
 * Pre-flight URL validation (scheme/host/DNS/IP) without downloading.
 */
export async function validateRemoteUrl(
  url: string,
  allowedHosts: string[] = [],
): Promise<SecurityCheckResult> {
  const result = await validateUrlForFetch(url, allowedHosts);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Minimal document shell — callers must still ingest to get local_path.
  return {
    ok: true,
    document: DocumentInputSchema.parse({
      document_id: "stmt_pending",
      source_type: "url",
      source_url: url,
      url,
      local_path: "/pending",
      mime_type: "application/pdf",
      extension: "pdf",
      file_size: 0,
      size_bytes: 0,
    }),
  };
}

export { detectFileType } from "./fileType.js";
export {
  assertHttpUrl,
  isBlockedHostname,
  isBlockedIpAddress,
  sanitizeUrlForLogs,
  validateUrlForFetch,
} from "./urlSafety.js";
